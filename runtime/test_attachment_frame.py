import base64
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import av
from PIL import Image


class AttachmentFrameTests(unittest.TestCase):
    def test_extracts_bounded_video_frame_and_rejects_invalid_timestamp(self):
        with tempfile.TemporaryDirectory() as directory:
            video = Path(directory) / 'sample.mp4'
            with av.open(str(video), 'w') as container:
                stream = container.add_stream('mpeg4', rate=24)
                stream.width = 64
                stream.height = 32
                stream.pix_fmt = 'yuv420p'
                for index in range(24):
                    frame = av.VideoFrame.from_image(Image.new('RGB', (64, 32), (index * 10, 60, 120)))
                    for packet in stream.encode(frame):
                        container.mux(packet)
                for packet in stream.encode():
                    container.mux(packet)
            script = str(Path(__file__).with_name('attachment-frame.py'))
            result = subprocess.run([sys.executable, script, str(video), '0.5'], check=True, capture_output=True, timeout=15)
            data = json.loads(result.stdout)
            self.assertGreaterEqual(data['seconds'], 0.45)
            image = Image.open(io.BytesIO(base64.b64decode(data['data'])))
            self.assertEqual(image.size, (64, 32))
            self.assertEqual(image.format, 'JPEG')
            invalid = subprocess.run([sys.executable, script, str(video), '-1'], capture_output=True, timeout=15)
            self.assertNotEqual(invalid.returncode, 0)


if __name__ == '__main__':
    unittest.main()