import base64
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from uuid import uuid4

from PIL import Image
from comfy_media import workflow, checked_source, validate_media, MODELS, ComfyMedia, stitch_story, prepare_references
from t4_workflow import t4_workflow, T4_MODELS, T4Client


class ComfyMediaTest(unittest.TestCase):
    def test_multiple_reference_execution_uploads_all_inputs_before_one_submission(self):
        sources = []
        for color in ['red', 'blue']:
            buffer = io.BytesIO()
            Image.new('RGB', (64, 32), color).save(buffer, format='PNG')
            raw = buffer.getvalue()
            sources.append({'assetId': str(uuid4()), 'png': base64.b64encode(raw).decode(), 'hash': hashlib.sha256(raw).hexdigest(), 'width': 64, 'height': 32})
        output = io.BytesIO()
        Image.new('RGB', (1024, 1024), 'white').save(output, format='PNG')
        for model in ['qwen-image-2.1', *T4_MODELS]:
            for native in [True, False]:
                with self.subTest(model=model, native=native), tempfile.TemporaryDirectory() as directory:
                    settings = Path(directory) / 'settings.json'
                    settings.write_text(json.dumps({'comfy': {'url': 'http://gpu.invalid'}}))
                    client = Mock(server_url='http://gpu.invalid')
                    client.check_models.return_value = ([], [])
                    client.submit.return_value = str(uuid4())
                    output_node = '8' if model == 'qwen-image-2.1' else '10'
                    client.poll.return_value = {'status': {'completed': True}, 'outputs': {output_node: {'images': [{'filename': 'image.png', 'type': 'output'}]}}}
                    queue = Mock()
                    queue.json.return_value = {'queue_running': [], 'queue_pending': []}
                    nodes = Mock()
                    names = ['image_1', 'image_2'] if native else ['image_1']
                    nodes.json.return_value = {'TextEncodeQwenImage21': {'input': {'required': {'images': ['COMFY_AUTOGROW_V3', {'template': {'names': names}}]}}}}
                    artifact = Mock()
                    artifact.iter_content.return_value = [output.getvalue()]
                    stream = Mock()
                    stream.__enter__ = Mock(return_value=artifact)
                    stream.__exit__ = Mock(return_value=False)
                    client.get.side_effect = [queue, nodes, stream]
                    def upload(_url, **kwargs):
                        response = Mock()
                        response.json.return_value = {'name': kwargs['files']['image'][0], 'subfolder': 'studio'}
                        return response
                    client.post.side_effect = upload
                    request = {'runId': str(uuid4()), 'model': model, 'prompt': 'combine', 'ratio': '1:1', 'size': '1024x1024', 'operation': 'edit', 'sourceImage': sources[0], 'sourceImages': sources}
                    with patch.dict(os.environ, {'SERVICES_FILE': str(settings), 'COMFYUI_T4_URL': 'http://gpu.invalid', 'COMFYUI_T4_TOKEN': 'fixture'}), patch('comfy_media.Path', side_effect=lambda value: Path(directory) if value == '/state/montage' else Path(value)), patch('comfy_media.ComfyUIClient', return_value=client), patch('comfy_media.T4Client', return_value=client), patch('comfy_media.requests.get', side_effect=client.get), patch('comfy_media.requests.post', side_effect=client.post), patch('comfy_media.write_checkpoint'):
                        result = ComfyMedia().execute(request)
                    self.assertTrue(result.success, result.error)
                    self.assertEqual(result.data['sourceHash'], sources[0]['hash'])
                    self.assertEqual(client.post.call_count, 2 if native else 1)
                    client.submit.assert_called_once()
                    graph = client.submit.call_args.args[0]
                    encoder = graph['4' if model == 'qwen-image-2.1' else '5']['inputs']
                    self.assertEqual(len([key for key in encoder if key.startswith('images.image_')]), 2 if native else 1)
                    if native:
                        self.assertEqual([call.kwargs['files']['image'][1] for call in client.post.call_args_list], [base64.b64decode(source['png']) for source in sources])
                    else:
                        self.assertIn('contact sheet of 2 references', encoder['prompt'])
                    ledger = json.loads((Path(directory) / request['runId'] / 'comfy-job.json').read_text())
                    self.assertEqual(ledger['source_asset_ids'], [source['assetId'] for source in sources])
                    self.assertEqual(ledger['reference_mode'], 'native' if native else 'contact-sheet')

    def test_multiple_references_use_native_inputs_or_complete_contact_sheet(self):
        sources = []
        for color in ['red', 'blue', 'green']:
            buffer = io.BytesIO()
            Image.new('RGB', (64, 32), color).save(buffer, format='PNG')
            raw = buffer.getvalue()
            sources.append({'assetId': color, 'png': base64.b64encode(raw).decode(), 'hash': hashlib.sha256(raw).hexdigest(), 'width': 64, 'height': 32, 'filename': f'{color}.png'})
        nodes = {'TextEncodeQwenImage21': {'input': {'required': {'images': ['COMFY_AUTOGROW_V3', {'template': {'names': ['image_1', 'image_2', 'image_3']}}]}}}}
        references, originals, combined = prepare_references(sources, nodes)
        self.assertFalse(combined)
        self.assertEqual(references, sources)
        self.assertEqual(originals, [base64.b64decode(source['png']) for source in sources])
        for model in ['qwen-image-2.1', *T4_MODELS]:
            graph, width, height, _ = workflow(model, 'combine', '3:4', 1, {**sources[0], 'references': sources}, size='960x1280')
            encoder = graph['4' if model == 'qwen-image-2.1' else '5']['inputs']
            self.assertEqual((width, height), (960, 1280))
            for index, source in enumerate(sources):
                node_id = encoder[f'images.image_{index + 1}'][0]
                self.assertEqual(graph[node_id]['inputs']['image'], source['filename'])
        for limited in [{}, {'TextEncodeQwenImage21': {'input': {'required': {'images': ['COMFY_AUTOGROW_V3', {'template': {'names': ['image_1', 'image_2']}}]}}}}]:
            references, originals, combined = prepare_references(sources, limited)
            self.assertTrue(combined)
            self.assertEqual(len(references), 1)
            self.assertEqual(checked_source(references[0]), originals[0])
            with Image.open(io.BytesIO(originals[0])) as image:
                self.assertEqual(image.size, (2048, 2048))
                self.assertEqual(image.getpixel((512, 528)), (255, 0, 0))
                self.assertEqual(image.getpixel((1536, 528)), (0, 0, 255))
                self.assertEqual(image.getpixel((512, 1552)), (0, 128, 0))
        with self.assertRaises(ValueError):
            prepare_references([sources[0], {**sources[1], 'hash': '0' * 64}], nodes)

    def test_t4_execution_uses_only_authenticated_proxy_and_keeps_source_bytes(self):
        buffer = io.BytesIO()
        Image.new('RGB', (1024, 1024), 'red').save(buffer, format='PNG')
        raw = buffer.getvalue()
        for model in T4_MODELS:
            for editing in [False, True]:
                with self.subTest(model=model, editing=editing), tempfile.TemporaryDirectory() as directory:
                    settings = Path(directory) / 'settings.json'
                    settings.write_text(json.dumps({'comfy': {'url': 'http://legacy.invalid'}}))
                    run_id = str(uuid4())
                    request = {'runId': run_id, 'model': model, 'prompt': 'test', 'ratio': '1:1'}
                    if editing:
                        request.update({'operation': 'edit', 'sourceImage': {'assetId': str(uuid4()), 'png': base64.b64encode(raw).decode(), 'hash': hashlib.sha256(raw).hexdigest(), 'width': 1024, 'height': 1024}})
                    client = Mock(server_url='http://10.48.1.5:8189')
                    client.check_models.return_value = (T4_MODELS[model], [])
                    client.submit.return_value = str(uuid4())
                    client.poll.return_value = {'status': {'completed': True}, 'outputs': {'10': {'images': [{'filename': 'image.png', 'subfolder': 'codex-studio', 'type': 'output'}]}}}
                    queue = Mock()
                    queue.json.return_value = {'queue_running': [], 'queue_pending': []}
                    artifact = Mock()
                    artifact.iter_content.return_value = [raw]
                    stream = Mock()
                    stream.__enter__ = Mock(return_value=artifact)
                    stream.__exit__ = Mock(return_value=False)
                    client.get.side_effect = [queue, stream]
                    client.post.return_value.json.return_value = {'name': f'{run_id}.png', 'subfolder': 'studio'}
                    with patch.dict(os.environ, {'SERVICES_FILE': str(settings), 'COMFYUI_T4_URL': client.server_url, 'COMFYUI_T4_TOKEN': 'fixture'}), patch('comfy_media.Path', side_effect=lambda value: Path(directory) if value == '/state/montage' else Path(value)), patch('comfy_media.T4Client', return_value=client), patch('comfy_media.ComfyUIClient', side_effect=AssertionError('Unexpected fallback')):
                        result = ComfyMedia().execute(request)
                        self.assertTrue(result.success, result.error)
                        self.assertEqual(result.model, model)
                        self.assertEqual((Path(directory) / run_id / 'image.png').read_bytes(), raw)
                        if editing:
                            self.assertEqual(client.post.call_args.kwargs['files']['image'][1], raw)
                            self.assertEqual(result.data['sourceHash'], hashlib.sha256(raw).hexdigest())
                        else:
                            client.post.assert_not_called()
                        self.assertFalse(ComfyMedia().execute(request).success)
                        client.submit.assert_called_once()

    def test_t4_proxy_auth_is_scoped_and_never_retries_submission(self):
        prompt_id = str(uuid4())
        client = T4Client('http://10.48.1.5:8189', 'fixture-token')
        response = Mock(status_code=200)
        response.json.return_value = {'prompt_id': prompt_id}
        with patch('t4_workflow.requests.request', return_value=response) as request:
            self.assertEqual(client.submit({}), prompt_id)
            request.assert_called_once()
            self.assertEqual(request.call_args.kwargs['headers'], {'Authorization': 'Bearer fixture-token'})
            self.assertFalse(request.call_args.kwargs['allow_redirects'])
            response.status_code = 302
            with self.assertRaisesRegex(ValueError, 'HTTP 302'):
                client.get(client.server_url + '/queue', timeout=1)
            with self.assertRaisesRegex(ValueError, 'outside'):
                client.get('https://example.com/queue')
            self.assertEqual(request.call_count, 2)
        for url in ['http://example.com:8189', 'http://10.48.1.5:8188', 'http://127.0.0.1:8189']:
            with self.assertRaises(ValueError):
                T4Client(url, 'fixture-token')
        with self.assertRaisesRegex(ValueError, 'missing'):
            T4Client('http://10.48.1.5:8189', '')

    def test_t4_four_workflows_preserve_reference_graph_parameters(self):
        for model in T4_MODELS:
            for source in [None, {'filename': 'original.png', 'width': 960, 'height': 1280}]:
                graph, width, height, output = t4_workflow(model, 'Exact prompt', '1:1', 123, source)
                self.assertEqual(graph['2']['inputs']['unet_name'], T4_MODELS[model][0])
                self.assertEqual(graph['5']['inputs']['prompt'], 'Exact prompt')
                self.assertEqual(graph['7']['class_type'], 'QwenImage21Cache')
                self.assertEqual(graph[output]['class_type'], 'SaveImageAdvanced')
                self.assertEqual((width, height), (960, 1280) if source else (1024, 1024))
                if source:
                    self.assertEqual(graph['8']['inputs']['latent_image'], ['5', 2])
                    self.assertEqual(graph['12']['inputs']['image'], source['filename'])
                if model.endswith('-turbo'):
                    self.assertEqual(graph['17']['inputs']['strength_model'], 1)
                    self.assertEqual(len(graph['19']['inputs']['sigmas'].split(',')), 9)
                    self.assertEqual(graph['8']['class_type'], 'SamplerCustom')
                else:
                    self.assertEqual(graph['8']['inputs']['steps'], 25)
            graph, width, height, _ = t4_workflow(model, 'Reframe', '1:1', 1, source, '2048x1152')
            self.assertEqual((width, height), (2048, 1152))
            self.assertEqual(graph['8']['inputs']['latent_image'], ['6', 0])
            self.assertEqual(graph['12']['inputs']['image'], 'original.png')

    def test_story_stitch_uses_native_tool_and_validates_project_clip_order(self):
        import subprocess
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run_id = str(uuid4())
            clip_ids = [str(uuid4()), str(uuid4())]
            for clip_id in clip_ids:
                (root / clip_id).mkdir()
                (root / clip_id / 'comfy-job.json').write_text(json.dumps({'run_id': clip_id, 'model': 'minimax-h3', 'status': 'completed'}))
                subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=24', '-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=stereo', '-t', '0.5', '-c:v', 'libx264', '-c:a', 'aac', str(root / clip_id / 'video.mp4')], check=True, capture_output=True)
            (root / f'{run_id}.json').write_text(json.dumps({'story': {'title': 'Story fixture', 'clipIds': clip_ids}, 'processedVideos': [{'assetId': clip_id, 'duration': 0.5, 'thumbnail': ''} for clip_id in clip_ids]}))
            request = {'runId': run_id, 'clipIds': clip_ids, 'width': 64, 'height': 64}
            with patch('comfy_media.Path', side_effect=lambda value: root if value in ['/state/montage', '/state/runs'] else Path(value)):
                with self.assertRaisesRegex(ValueError, 'ownership or order'):
                    stitch_story({**request, 'clipIds': list(reversed(clip_ids))})
                result = stitch_story(request)
                self.assertTrue(result['success'])
                self.assertAlmostEqual(result['duration'], 1, delta=0.15)
                self.assertEqual(result['fps'], 24)
                self.assertTrue((root / run_id / 'checkpoint_assets.json').is_file())
                with self.assertRaises(FileExistsError):
                    stitch_story(request)

    def test_explicit_edit_dimensions_use_target_latent_and_unchanged_reference(self):
        source = {'filename': 'original.png', 'width': 1024, 'height': 1024}
        graph, width, height, _ = workflow('qwen-image-2.1', 'reframe wide', '1:1', 1, source, size='2048x1152')
        self.assertEqual((width, height), (2048, 1152))
        self.assertEqual(graph['5']['inputs']['width'], 2048)
        self.assertEqual(graph['6']['inputs']['latent_image'], ['5', 0])
        self.assertEqual(graph['4']['inputs']['images.image_1'], ['9', 0])
        self.assertEqual(graph['9']['inputs']['image'], 'original.png')

    def test_exact_ratios_and_quality_steps(self):
        for model in MODELS:
            for ratio in ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16']:
                graph, width, height, _ = workflow(model, 'test', ratio, 1, quality='high')
                horizontal, vertical = map(int, ratio.split(':'))
                self.assertEqual(width * vertical, height * horizontal)
                self.assertEqual(width % 32, 0)
                self.assertEqual(height % 32, 0)
                self.assertEqual(graph['8' if model == 'minimax-h3' else '6']['inputs']['steps'], 40 if model == 'minimax-h3' else 50)

    def test_edit_uses_namespaced_dynamic_input(self):
        graph, _, _, _ = workflow('qwen-image-2.1', 'edit', '1:1', 1, {'filename': 'input.png', 'width': 1024, 'height': 1024})
        self.assertEqual(graph['4']['inputs']['images.image_1'], ['9', 0])
        self.assertNotIn('image_1', graph['4']['inputs'])

    def test_execute_writes_real_checkpoint_and_never_resubmits(self):
        buffer = io.BytesIO()
        Image.new('RGB', (1024, 1024), 'red').save(buffer, format='PNG')
        response = Mock()
        response.json.return_value = {'queue_running': [], 'queue_pending': []}
        artifact = Mock()
        artifact.iter_content.return_value = [buffer.getvalue()]
        stream = Mock()
        stream.__enter__ = Mock(return_value=artifact)
        stream.__exit__ = Mock(return_value=False)
        client = Mock(server_url='http://gpu.invalid')
        client.check_models.return_value = (MODELS['qwen-image-2.1'], [])
        client.submit.return_value = str(uuid4())
        client.poll.return_value = {'status': {'completed': True}, 'outputs': {'8': {'images': [{'filename': 'image.png', 'subfolder': 'studio', 'type': 'output'}]}}}
        with tempfile.TemporaryDirectory() as directory:
            settings = Path(directory) / 'settings.json'
            settings.write_text(json.dumps({'comfy': {'url': 'http://gpu.invalid'}}))
            run_id = str(uuid4())
            request = {'runId': run_id, 'model': 'qwen-image-2.1', 'prompt': 'test', 'ratio': '1:1'}
            with patch.dict(os.environ, {'SERVICES_FILE': str(settings)}), patch('comfy_media.Path', side_effect=lambda value: Path(directory) if value == '/state/montage' else Path(value)), patch('comfy_media.ComfyUIClient', return_value=client), patch('comfy_media.requests.get', side_effect=[response, stream]):
                result = ComfyMedia().execute(request)
                self.assertTrue(result.success, result.error)
                self.assertTrue((Path(directory) / run_id / 'checkpoint_assets.json').exists())
                self.assertEqual((Path(directory) / run_id / 'image.png').read_bytes(), buffer.getvalue())
                self.assertFalse(ComfyMedia().execute(request).success)
                client.submit.assert_called_once()

    def test_model_routing_and_limits(self):
        for model in MODELS:
            graph, width, height, output = workflow(model, 'test', '3:2', 123)
            self.assertIn(output, graph)
            self.assertEqual(graph['1']['inputs']['unet_name'], MODELS[model][0])
            self.assertEqual(width % 32, 0)
            self.assertEqual(height % 32, 0)
        self.assertEqual(workflow('minimax-h3', 'test', '2:3', 1)[0]['5']['inputs']['length'], 124)
        with self.assertRaises(KeyError):
            workflow('other', 'test', '1:1', 1)

    def test_edit_uses_original_pixels_and_source_latent(self):
        buffer = io.BytesIO()
        Image.new('RGB', (64, 64), 'red').save(buffer, format='PNG')
        raw = buffer.getvalue()
        source = {'png': base64.b64encode(raw).decode(), 'hash': hashlib.sha256(raw).hexdigest(), 'width': 64, 'height': 64, 'filename': 'studio/source.png'}
        self.assertEqual(checked_source(source), raw)
        graph, width, height, _ = workflow('qwen-image-2.1', 'edit', '3:2', 1, source)
        self.assertEqual((width, height), (64, 64))
        self.assertEqual(graph['4']['inputs']['images.image_1'], ['9', 0])
        self.assertEqual(graph['6']['inputs']['latent_image'], ['4', 2])
        with self.assertRaises(ValueError):
            checked_source({**source, 'hash': '0' * 64})
        with self.assertRaises(ValueError):
            workflow('minimax-h3', 'edit', '1:1', 1, source)
        self.assertEqual(validate_media(raw, False, 64, 64)['png'], source['png'])
        with self.assertRaises(ValueError):
            validate_media(raw, False, 1024, 1024)


if __name__ == '__main__':
    unittest.main()