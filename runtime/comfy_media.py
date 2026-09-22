import base64
import hashlib
import io
import json
import os
from pathlib import Path
import time
from uuid import UUID

import requests
from PIL import Image
from tools.base_tool import BaseTool, ToolResult, ToolTier, ToolRuntime
from tools._comfyui.client import ComfyUIClient
from lib.checkpoint import write_checkpoint

MODELS = {
    'qwen-image-2.1': ['qwen_image_2.1_bf16.safetensors', 'qwen3vl_8b_bf16.safetensors', 'qwen_image_2.1_vae_bf16.safetensors'],
    'minimax-h3': ['minimax_h3_fl2va_pruned_bf16.safetensors', 'qwen3vl_32b_minimax_h3_bf16.safetensors', 'minimax_h3_video_vae_fp16.safetensors', 'minimax_h3_audio_vae_fp32.safetensors'],
}


def workflow(model, prompt, ratio, seed, source=None, quality='low', size=None):
    weights = MODELS[model]
    video = model == 'minimax-h3'
    width, height = ({'1:1': (640, 640), '3:2': (768, 512), '2:3': (512, 768), '4:3': (768, 576), '3:4': (576, 768), '16:9': (1024, 576), '9:16': (576, 1024)} if video else {'1:1': (1024, 1024), '3:2': (1536, 1024), '2:3': (1024, 1536), '4:3': (1280, 960), '3:4': (960, 1280), '16:9': (1536, 864), '9:16': (864, 1536)})[ratio]
    steps = ({'low': 20, 'medium': 30, 'high': 40} if video else {'low': 25, 'medium': 35, 'high': 50})[quality]
    if source:
        if video:
            raise ValueError('Video source inputs are not enabled')
        width, height = source['width'], source['height']
    if size and not video:
        width, height = map(int, size.split('x'))
    if not video and (width <= 0 or height <= 0 or width % 32 or height % 32 or width * height > 4_194_304):
        raise ValueError('Unsupported Qwen output dimensions')
    graph = {
        '1': {'class_type': 'UNETLoader', 'inputs': {'unet_name': weights[0], 'weight_dtype': 'default'}},
        '2': {'class_type': 'CLIPLoader', 'inputs': {'clip_name': weights[1], 'type': 'minimax' if video else 'qwen_image', 'device': 'default'}},
        '3': {'class_type': 'VAELoader', 'inputs': {'vae_name': weights[2]}},
    }
    if not video:
        graph.update({
            '4': {'class_type': 'TextEncodeQwenImage21', 'inputs': {'clip': ['2', 0], 'prompt': prompt, 'negative_prompt': '', 'resolution': 0}},
            '5': {'class_type': 'EmptyLatentImage', 'inputs': {'width': width, 'height': height, 'batch_size': 1}},
            '6': {'class_type': 'KSampler', 'inputs': {'model': ['1', 0], 'positive': ['4', 0], 'negative': ['4', 1], 'latent_image': ['5', 0], 'seed': seed, 'steps': steps, 'cfg': 1, 'sampler_name': 'euler', 'scheduler': 'simple', 'denoise': 1}},
            '7': {'class_type': 'VAEDecode', 'inputs': {'samples': ['6', 0], 'vae': ['3', 0]}},
            '8': {'class_type': 'SaveImage', 'inputs': {'images': ['7', 0], 'filename_prefix': f'studio/{seed}'}},
        })
        if source:
            graph['9'] = {'class_type': 'LoadImage', 'inputs': {'image': source['filename']}}
            graph['4']['inputs'].update({'vae': ['3', 0], 'images.image_1': ['9', 0]})
            if (width, height) == (source['width'], source['height']):
                graph['6']['inputs']['latent_image'] = ['4', 2]
    else:
        graph.update({
            '4': {'class_type': 'VAELoader', 'inputs': {'vae_name': weights[3]}},
            '5': {'class_type': 'MiniMaxH3ImageToVideo', 'inputs': {'clip': ['2', 0], 'vae': ['3', 0], 'prompt': prompt, 'width': width, 'height': height, 'length': 124}},
            '6': {'class_type': 'RandomNoise', 'inputs': {'noise_seed': seed}},
            '7': {'class_type': 'KSamplerSelect', 'inputs': {'sampler_name': 'res_multistep'}},
            '8': {'class_type': 'BasicScheduler', 'inputs': {'model': ['1', 0], 'scheduler': 'simple', 'steps': steps, 'denoise': 1}},
            '9': {'class_type': 'BasicGuider', 'inputs': {'model': ['1', 0], 'conditioning': ['5', 0]}},
            '10': {'class_type': 'SamplerCustomAdvanced', 'inputs': {'noise': ['6', 0], 'guider': ['9', 0], 'sampler': ['7', 0], 'sigmas': ['8', 0], 'latent_image': ['5', 1]}},
            '11': {'class_type': 'VAEDecode', 'inputs': {'samples': ['10', 0], 'vae': ['3', 0]}},
            '12': {'class_type': 'VAEDecodeAudio', 'inputs': {'samples': ['10', 0], 'vae': ['4', 0]}},
            '13': {'class_type': 'CreateVideo', 'inputs': {'images': ['11', 0], 'audio': ['12', 0], 'fps': 24}},
            '14': {'class_type': 'SaveVideo', 'inputs': {'video': ['13', 0], 'filename_prefix': f'studio/{seed}', 'format': 'auto', 'codec': 'auto'}},
        })
    return graph, width, height, '14' if video else '8'


def checked_source(source):
    raw = base64.b64decode(source['png'], validate=True)
    if len(raw) > 32 * 1024**2 or hashlib.sha256(raw).hexdigest() != source['hash']:
        raise ValueError('Invalid source image hash')
    with Image.open(io.BytesIO(raw)) as image:
        if image.format != 'PNG' or image.size != (source['width'], source['height']) or image.width * image.height > 4_194_304:
            raise ValueError('Invalid source image dimensions')
        image.load()
    return raw


def validate_media(raw, video, width, height):
    if not video:
        with Image.open(io.BytesIO(raw)) as image:
            if image.format != 'PNG' or image.size != (width, height):
                raise ValueError('Unexpected image format or dimensions')
            image.load()
        return {'png': base64.b64encode(raw).decode()}
    import av
    with av.open(io.BytesIO(raw)) as container:
        stream = container.streams.video[0]
        if (stream.width, stream.height) != (width, height) or float(stream.average_rate) != 24 or len(container.streams.audio) != 1:
            raise ValueError('Invalid video dimensions, rate or audio')
        audio_stream = container.streams.audio[0]
        if audio_stream.codec_context.channels != 2:
            raise ValueError('Expected stereo audio')
        count = 0
        poster = None
        for frame in container.decode(video=0):
            if count == 0:
                poster = frame.to_image()
            count += 1
            if count > 124:
                raise ValueError('Video too long')
        if count != 124 or poster is None:
            raise ValueError('Unexpected video frame count')
    with av.open(io.BytesIO(raw)) as container:
        if next(container.decode(audio=0), None) is None:
            raise ValueError('Missing audio samples')
    thumbnail = io.BytesIO()
    poster.thumbnail((480, 480))
    poster.save(thumbnail, format='WEBP')
    return {'mp4': base64.b64encode(raw).decode(), 'thumbnail': base64.b64encode(thumbnail.getvalue()).decode(), 'duration': count / 24, 'fps': 24}


class ComfyMedia(BaseTool):
    name = 'studio_comfy_media'
    provider = 'comfyui'
    capability = 'media_generation'
    tier = ToolTier.GENERATE
    runtime = ToolRuntime.API
    fallback_tools = []

    def execute(self, inputs):
        started = time.monotonic()
        run_id = str(UUID(inputs['runId']))
        root = Path('/state/montage')
        project = root / run_id
        project.mkdir(parents=True, exist_ok=True)
        ledger = project / 'comfy-job.json'
        model = inputs['model']
        video = model == 'minimax-h3'
        source = inputs.get('sourceImage')
        operation = inputs.get('operation', 'generate')
        if model not in MODELS or not 1 <= len(inputs['prompt']) <= 6000:
            raise ValueError('Invalid model or prompt')
        if (operation == 'edit') != bool(source) or (video and source):
            raise ValueError('Invalid edit source')
        settings = json.loads(Path(os.environ['SERVICES_FILE']).read_text()).get('comfy', {})
        server_url = settings.get('url') or os.environ.get('COMFYUI_SERVER_URL')
        if not server_url:
            return ToolResult(success=False, error='ComfyUI is not configured; no request submitted')
        client = ComfyUIClient(server_url)
        prompt_id = None
        try:
            if ledger.exists():
                raise ValueError('Existing ComfyUI submission; verify prior result, no automatic resubmission')
            _, missing = client.check_models(MODELS[model])
            if missing:
                raise ValueError('Selected model files are not ready')
            response = requests.get(f'{client.server_url}/queue', timeout=10)
            response.raise_for_status()
            queue = response.json()
            if queue.get('queue_running') or queue.get('queue_pending'):
                raise ValueError('GPU is busy; no request submitted')
            if source:
                raw = checked_source(source)
                response = requests.post(f'{client.server_url}/upload/image', files={'image': (f'{run_id}.png', raw, 'image/png')}, data={'type': 'input', 'subfolder': 'studio'}, timeout=30)
                response.raise_for_status()
                uploaded = response.json()
                source = {**source, 'filename': '/'.join(filter(None, [uploaded.get('subfolder'), uploaded['name']]))}
            seed = int(UUID(run_id)) % (2**53)
            graph, width, height, output_node = workflow(model, inputs['prompt'], inputs['ratio'], seed, source, inputs.get('quality', 'low'), inputs.get('size'))
            workflow_hash = hashlib.sha256(json.dumps(graph, sort_keys=True).encode()).hexdigest()
            record = {'run_id': run_id, 'model': model, 'seed': seed, 'workflow_hash': workflow_hash, 'ratio': inputs['ratio'], 'quality': inputs.get('quality', 'low'), 'status': 'submitting'}
            ledger.write_text(json.dumps(record))
            (project / 'workflow.json').write_text(json.dumps(graph, indent=2))
            prompt_id = client.submit(graph)
            record.update({'prompt_id': prompt_id, 'status': 'submitted'})
            ledger.write_text(json.dumps(record))
            print(json.dumps({'id': 'comfy-submit', 'label': 'ComfyUI 任务已提交', 'detail': prompt_id}), file=__import__('sys').stderr, flush=True)
            history = client.poll(prompt_id, timeout=1500 if video else 300, interval=2)
            if not history.get('status', {}).get('completed'):
                raise ValueError('ComfyUI task did not complete')
            outputs = history['outputs'][output_node]
            extension = '.mp4' if video else '.png'
            artifacts = [item for group in outputs.values() if isinstance(group, list) for item in group if isinstance(item, dict) and item.get('filename', '').endswith(extension)]
            if len(artifacts) != 1:
                raise ValueError('Expected one output artifact')
            artifact = artifacts[0]
            if artifact.get('type') != 'output' or '..' in artifact['filename'] or '..' in artifact.get('subfolder', ''):
                raise ValueError('Invalid artifact reference')
            with requests.get(f'{client.server_url}/view', params={key: artifact[key] for key in ['filename', 'subfolder', 'type'] if key in artifact}, timeout=(10, 120), stream=True) as response:
                response.raise_for_status()
                chunks = []
                total = 0
                for chunk in response.iter_content(1024 * 1024):
                    total += len(chunk)
                    if total > 48 * 1024**2:
                        raise ValueError('Artifact too large')
                    chunks.append(chunk)
            raw = b''.join(chunks)
            data = validate_media(raw, video, width, height)
            filename = 'video.mp4' if video else 'image.png'
            (project / filename).write_bytes(raw)
            metadata = {'operation': operation, 'prompt_id': prompt_id, 'workflow_hash': workflow_hash, 'seed': seed, 'cost_status': 'gpu-runtime', **({'source_asset_id': source['assetId'], 'source_hash': source['hash']} if source else {})}
            manifest = {'version': '1.0', 'assets': [{'id': run_id, 'type': 'video' if video else 'image', 'path': filename, 'source_tool': self.name, 'scene_id': 'single', 'model': model, 'provider': self.provider, 'resolution': f'{width}x{height}', 'format': extension[1:], 'prompt': inputs['prompt']}], 'metadata': metadata}
            write_checkpoint(root, run_id, 'assets', 'completed', {'asset_manifest': manifest})
            record['status'] = 'completed'
            ledger.write_text(json.dumps(record))
            return ToolResult(success=True, data={**data, 'width': width, 'height': height, 'provider': self.provider, 'operation': operation, 'checkpoint': f'{run_id}/checkpoint_assets.json', **({'sourceAssetId': source['assetId'], 'sourceHash': source['hash']} if source else {})}, model=model, duration_seconds=time.monotonic() - started, cost_usd=None)
        except Exception:
            return ToolResult(success=False, error=f'ComfyUI task unavailable or unverified; no automatic retry. Prompt: {prompt_id or "not confirmed"}; inspect persisted job before retrying.')


def main():
    import sys
    request = json.load(sys.stdin)
    result = ComfyMedia().execute(request)
    print(json.dumps({'success': result.success, **(result.data or {}), 'model': result.model, **({'error': result.error} if not result.success else {})}))


if __name__ == '__main__':
    main()