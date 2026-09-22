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
from comfy_media import workflow, checked_source, validate_media, MODELS, ComfyMedia


class ComfyMediaTest(unittest.TestCase):
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