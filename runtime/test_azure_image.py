import base64
import hashlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, Mock
from uuid import uuid4

from PIL import Image
from azure_image import AzureImage, main


class AzureImageTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.settings = Path(self.directory.name) / "services.json"
        self.settings.write_text(json.dumps({"image": {"endpoint": "https://test.invalid", "deployment": "gpt-image-2"}}))
        self.environment = patch.dict(os.environ, {"SERVICES_FILE": str(self.settings)})
        self.environment.start()
        image = io.BytesIO()
        Image.new("RGB", (1024, 1024), "white").save(image, format="PNG")
        self.original = image.getvalue()
        self.source = {"assetId": "prior-image", "png": base64.b64encode(self.original).decode(),
            "hash": hashlib.sha256(self.original).hexdigest(), "width": 1024, "height": 1024}
        self.response = Mock(status_code=200)
        self.response.json.return_value = {"data": [{"b64_json": self.source["png"]}]}

    def tearDown(self):
        self.environment.stop()
        self.directory.cleanup()

    @patch("azure_image.requests.post")
    def test_quality_is_forwarded_for_generation_and_edit(self, post):
        post.return_value = self.response
        for quality in ['low', 'medium', 'high']:
            for operation in ['generate', 'edit']:
                result = AzureImage('test-token').execute({'prompt': 'test', 'size': '1024x1024', 'quality': quality, 'operation': operation, **({'sourceImage': self.source} if operation == 'edit' else {})})
                self.assertTrue(result.success)
                self.assertEqual(post.call_args.kwargs['data' if operation == 'edit' else 'json']['quality'], quality)

    @patch("azure_image.requests.post")
    def test_main_saves_image_and_real_checkpoint(self, post):
        post.return_value = self.response
        run_id = str(uuid4())
        request = {"runId": run_id, "accessToken": "test-token", "prompt": "Make it red", "size": "1024x1024", "operation": "edit", "sourceImage": self.source}
        with patch("azure_image.sys.stdin", io.StringIO(json.dumps(request))), patch("azure_image.sys.stdout", new_callable=io.StringIO) as output, patch("azure_image.Path", side_effect=lambda value: Path(self.directory.name) if value == "/state/montage" else Path(value)):
            main()
        result = json.loads(output.getvalue())
        self.assertTrue(result["success"])
        self.assertEqual((Path(self.directory.name) / run_id / "image.png").read_bytes(), self.original)
        self.assertTrue((Path(self.directory.name) / run_id / "checkpoint_assets.json").exists())

    @patch("azure_image.requests.post")
    def test_edit_uploads_exact_original_and_records_lineage(self, post):
        post.return_value = self.response
        result = AzureImage("test-token").execute({"prompt": "Make it red", "size": "1024x1024", "operation": "edit", "sourceImage": self.source})
        self.assertTrue(result.success)
        self.assertEqual(result.data["sourceAssetId"], "prior-image")
        self.assertEqual(result.data["sourceHash"], self.source["hash"])
        self.assertEqual(result.data["operation"], "edit")
        self.assertEqual(post.call_args.args[0], "https://test.invalid/openai/v1/images/edits")
        self.assertEqual(post.call_args.kwargs["files"]["image"], ("source.png", self.original, "image/png"))
        self.assertNotIn("json", post.call_args.kwargs)
        self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], "Bearer test-token")
        self.assertEqual(post.call_args.kwargs["data"]["n"], 1)

    @patch("azure_image.requests.post")
    def test_generation_still_uses_json_without_reference(self, post):
        post.return_value = self.response
        result = AzureImage("test-token").execute({"prompt": "White mug", "size": "1024x1024"})
        self.assertTrue(result.success)
        self.assertEqual(result.data["operation"], "generate")
        self.assertNotIn("sourceAssetId", result.data)
        self.assertTrue(post.call_args.args[0].endswith("/generations"))
        self.assertNotIn("files", post.call_args.kwargs)

    @patch("azure_image.requests.post")
    def test_missing_or_corrupt_source_never_calls_model(self, post):
        for source in [None, {**self.source, "hash": "0" * 64}, {**self.source, "width": 512}]:
            result = AzureImage("test-token").execute({"prompt": "Edit", "size": "1024x1024", "operation": "edit", **({"sourceImage": source} if source else {})})
            self.assertFalse(result.success)
        post.assert_not_called()

    @patch("azure_image.requests.post")
    def test_failed_edit_does_not_retry_or_fall_back(self, post):
        post.return_value = Mock(status_code=400)
        result = AzureImage("test-token").execute({"prompt": "Edit", "size": "1024x1024", "operation": "edit", "sourceImage": self.source})
        self.assertFalse(result.success)
        self.assertIn("edit HTTP 400", result.error)
        post.assert_called_once()


if __name__ == "__main__":
    unittest.main()