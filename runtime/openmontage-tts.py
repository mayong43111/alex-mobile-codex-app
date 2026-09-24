import base64
import json
import os
from pathlib import Path
import sys
import tempfile

from tools.audio.azure_tts import AzureTTS


def main():
    request = json.load(sys.stdin)
    os.environ['AZURE_SPEECH_TOKEN'] = request['token']
    os.environ['AZURE_TTS_ENDPOINT'] = request['endpoint'].rstrip('/') + '/tts'
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory) / 'narration.wav'
        result = AzureTTS().execute({'text': request['text'], 'voice': request['voice'], 'locale': 'zh-CN', 'output_format': 'wav', 'output_path': str(output)})
        if not result.success:
            raise RuntimeError('OpenMontage Azure TTS failed; do not automatically resubmit')
        data = output.read_bytes()
        if len(data) > 16 * 1024 * 1024:
            raise ValueError('Narration is too large')
        print(json.dumps({'wav': base64.b64encode(data).decode()}))


if __name__ == '__main__':
    main()