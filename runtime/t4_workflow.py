import ipaddress
import time
from urllib.parse import urlsplit
from uuid import UUID

import requests

T4_MODELS = {
    'qwen-image-2.1-t4': ['qwen_image_2.1_int8_convrot.safetensors', 'qwen3vl_8b_int8_convrot.safetensors', 'qwen_image_2.1_vae_bf16.safetensors'],
    'qwen-image-2.1-t4-turbo': ['qwen_image_2.1_int8_convrot.safetensors', 'qwen3vl_8b_int8_convrot.safetensors', 'qwen_image_2.1_vae_bf16.safetensors', 'qwen_image_2.1_turbo_lora_avg_rank_178_bf16.safetensors'],
}


def t4_workflow(model, prompt, ratio, seed, source=None, size=None):
    weights = T4_MODELS[model]
    turbo = model.endswith('-turbo')
    width, height = {'1:1': (1024, 1024), '3:2': (1536, 1024), '2:3': (1024, 1536), '4:3': (1280, 960), '3:4': (960, 1280), '16:9': (1536, 864), '9:16': (864, 1536)}[ratio]
    if source:
        width, height = source['width'], source['height']
    if size:
        width, height = map(int, size.split('x'))
    if width <= 0 or height <= 0 or width % 32 or height % 32 or width * height > 4_194_304:
        raise ValueError('Unsupported T4 output dimensions')
    graph = {
        '2': {'class_type': 'UNETLoader', 'inputs': {'unet_name': weights[0], 'weight_dtype': 'default'}},
        '3': {'class_type': 'CLIPLoader', 'inputs': {'clip_name': weights[1], 'type': 'qwen_image', 'device': 'default'}},
        '4': {'class_type': 'VAELoader', 'inputs': {'vae_name': weights[2]}},
        '5': {'class_type': 'TextEncodeQwenImage21', 'inputs': {'clip': ['3', 0], 'prompt': prompt, 'negative_prompt': '', 'resolution': 0 if source else 1024}},
        '6': {'class_type': 'EmptyLatentImage', 'inputs': {'width': width, 'height': height, 'batch_size': 1}},
        '7': {'class_type': 'QwenImage21Cache', 'inputs': {'model': ['17' if turbo else '2', 0], 'device': 'auto', 'dtype': 'default'}},
        '8': {'class_type': 'KSampler', 'inputs': {'model': ['7', 0], 'positive': ['5', 0], 'negative': ['5', 1], 'latent_image': ['6', 0], 'seed': seed, 'steps': 25, 'cfg': 1, 'sampler_name': 'euler', 'scheduler': 'simple', 'denoise': 1}},
        '9': {'class_type': 'VAEDecode', 'inputs': {'samples': ['8', 0], 'vae': ['4', 0]}},
        '10': {'class_type': 'SaveImageAdvanced', 'inputs': {'images': ['9', 0], 'filename_prefix': f'codex-studio/{seed}', 'format': 'png', 'format.bit_depth': '8-bit', 'format.input_color_space': 'sRGB'}},
    }
    if turbo:
        graph.update({
            '17': {'class_type': 'LoraLoaderModelOnly', 'inputs': {'model': ['2', 0], 'lora_name': weights[3], 'strength_model': 1}},
            '18': {'class_type': 'KSamplerSelect', 'inputs': {'sampler_name': 'euler'}},
            '19': {'class_type': 'ManualSigmas', 'inputs': {'sigmas': '1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0.0'}},
        })
        graph['8'] = {'class_type': 'SamplerCustom', 'inputs': {'model': ['7', 0], 'add_noise': True, 'noise_seed': seed, 'cfg': 1, 'positive': ['5', 0], 'negative': ['5', 1], 'sampler': ['18', 0], 'sigmas': ['19', 0], 'latent_image': ['6', 0]}}
    if source:
        graph['5']['inputs']['vae'] = ['4', 0]
        for index, reference in enumerate(source.get('references', [source])):
            node_id = '12' if index == 0 else str(20 + index)
            graph[node_id] = {'class_type': 'LoadImage', 'inputs': {'image': reference['filename']}}
            graph['5']['inputs'][f'images.image_{index + 1}'] = [node_id, 0]
        if (width, height) == (source['width'], source['height']):
            graph['8']['inputs']['latent_image'] = ['5', 2]
            del graph['6']
    return graph, width, height, '10'


class T4Client:
    def __init__(self, url, token):
        parsed = urlsplit(url)
        address = ipaddress.ip_address(parsed.hostname)
        if parsed.scheme != 'http' or parsed.port != 8189 or parsed.username or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment or not any(address in ipaddress.ip_network(network) for network in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')):
            raise ValueError('T4 requires its authenticated private proxy')
        if not isinstance(token, str) or not token.strip():
            raise ValueError('T4 proxy token is missing')
        self.server_url = url.rstrip('/')
        self.headers = {'Authorization': f'Bearer {token}'}

    def request(self, method, url, **kwargs):
        if not url.startswith(self.server_url + '/'):
            raise ValueError('T4 request outside configured proxy')
        response = requests.request(method, url, headers=self.headers, allow_redirects=False, **kwargs)
        if not 200 <= response.status_code < 300:
            raise ValueError(f'T4 proxy HTTP {response.status_code}')
        return response

    def get(self, url, **kwargs):
        return self.request('GET', url, **kwargs)

    def post(self, url, **kwargs):
        return self.request('POST', url, **kwargs)

    def check_models(self, required):
        nodes = self.get(f'{self.server_url}/object_info', timeout=15).json()
        available = set()
        for node, field in [('UNETLoader', 'unet_name'), ('CLIPLoader', 'clip_name'), ('VAELoader', 'vae_name'), ('LoraLoaderModelOnly', 'lora_name')]:
            available.update(nodes.get(node, {}).get('input', {}).get('required', {}).get(field, [[]])[0])
        needed = ['TextEncodeQwenImage21', 'QwenImage21Cache', 'VAEDecode', 'SaveImageAdvanced', 'LoadImage', 'EmptyLatentImage']
        needed += ['SamplerCustom', 'KSamplerSelect', 'ManualSigmas', 'LoraLoaderModelOnly'] if len(required) == 4 else ['KSampler']
        return [name for name in required if name in available], [name for name in required if name not in available] + [name for name in needed if name not in nodes]

    def submit(self, graph):
        response = self.post(f'{self.server_url}/prompt', json={'prompt': graph}, timeout=30)
        return str(UUID(response.json()['prompt_id']))

    def poll(self, prompt_id, timeout=1800, interval=2):
        prompt_id = str(UUID(prompt_id))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            record = self.get(f'{self.server_url}/history/{prompt_id}', timeout=15).json().get(prompt_id)
            if record:
                if record.get('status', {}).get('status_str') == 'error':
                    raise ValueError('T4 execution failed; no automatic retry')
                if record.get('status', {}).get('completed'):
                    return record
            time.sleep(interval)
        raise TimeoutError('T4 result unverified; no automatic resubmission')