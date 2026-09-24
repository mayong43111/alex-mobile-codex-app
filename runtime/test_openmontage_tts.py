import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from tools.audio.azure_tts import AzureTTS
from tools.base_tool import ToolStatus


class OpenMontageTtsTest(unittest.TestCase):
    def test_managed_identity_uses_native_ssml_and_single_request(self):
        response = Mock(status_code=200, content=b'wave-test', text='')
        environment = {'AZURE_SPEECH_TOKEN': 'test-token', 'AZURE_TTS_ENDPOINT': 'https://example.cognitiveservices.azure.com/tts'}
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, environment, clear=True), patch('requests.post', return_value=response) as request:
            tool = AzureTTS()
            self.assertEqual(tool.get_status(), ToolStatus.AVAILABLE)
            output = Path(directory) / 'speech.wav'
            result = tool.execute({'text': 'Terms <conditions> & rights', 'voice': 'zh-CN-XiaoxiaoNeural', 'locale': 'zh-CN', 'output_format': 'wav', 'output_path': str(output)})
            self.assertTrue(result.success, result.error)
            request.assert_called_once()
            self.assertEqual(request.call_args.args[0], environment['AZURE_TTS_ENDPOINT'] + '/cognitiveservices/v1')
            headers = request.call_args.kwargs['headers']
            self.assertEqual(headers['Authorization'], 'Bearer test-token')
            self.assertNotIn('Ocp-Apim-Subscription-Key', headers)
            self.assertIn(b'&lt;conditions&gt; &amp; rights', request.call_args.kwargs['data'])
            self.assertEqual(output.read_bytes(), b'wave-test')

    def test_existing_key_authentication_is_preserved(self):
        response = Mock(status_code=200, content=b'wave-test', text='')
        environment = {'AZURE_SPEECH_KEY': 'test-key', 'AZURE_SPEECH_REGION': 'southeastasia'}
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, environment, clear=True), patch('requests.post', return_value=response) as request:
            result = AzureTTS().execute({'text': 'Test', 'output_path': str(Path(directory) / 'speech.mp3')})
            self.assertTrue(result.success, result.error)
            self.assertEqual(request.call_args.kwargs['headers']['Ocp-Apim-Subscription-Key'], 'test-key')
            self.assertNotIn('Authorization', request.call_args.kwargs['headers'])

    def test_missing_authentication_does_not_submit(self):
        with patch.dict(os.environ, {}, clear=True), patch('requests.post') as request:
            tool = AzureTTS()
            self.assertEqual(tool.get_status(), ToolStatus.UNAVAILABLE)
            self.assertFalse(tool.execute({'text': 'Test'}).success)
            request.assert_not_called()


if __name__ == '__main__':
    unittest.main()