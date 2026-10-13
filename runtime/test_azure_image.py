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
    def test_custom_output_dimensions_are_sent_for_generation_and_edit(self, post):
        output = io.BytesIO()
        Image.new('RGB', (2048, 1152), 'white').save(output, format='PNG')
        self.response.json.return_value = {'data': [{'b64_json': base64.b64encode(output.getvalue()).decode()}]}
        post.return_value = self.response
        for operation in ['generate', 'edit']:
            result = AzureImage('test-token').execute({'prompt': 'wide', 'size': '2048x1152', 'operation': operation, **({'sourceImage': self.source} if operation == 'edit' else {})})
            self.assertTrue(result.success)
            self.assertEqual(post.call_args.kwargs['data' if operation == 'edit' else 'json']['size'], '2048x1152')
            self.assertEqual((result.data['width'], result.data['height']), (2048, 1152))

    @patch("azure_image.requests.post")
    def test_invalid_output_size_is_not_silently_replaced(self, post):
        for size in ['1920x1080', '4096x2048', '512x512', '3840x512', '3840x3840']:
            result = AzureImage('test-token').execute({'prompt': 'test', 'size': size})
            self.assertFalse(result.success)
        post.assert_not_called()

    @patch("azure_image.requests.post")
    def test_phone_photo_edit_uses_auto_without_resizing_source(self, post):
        original = io.BytesIO()
        Image.new("RGB", (3024, 4032), "white").save(original, format="PNG")
        raw = original.getvalue().ljust(38_823_614, b'\0')
        source = {**self.source, "width": 3024, "height": 4032,
            "png": base64.b64encode(raw).decode(), "hash": hashlib.sha256(raw).hexdigest()}
        post.return_value = self.response
        result = AzureImage("test-token").execute({"prompt": "Edit photo", "size": "auto", "operation": "edit", "sourceImage": source})
        self.assertTrue(result.success)
        self.assertEqual(post.call_args.kwargs["data"]["size"], "auto")
        self.assertEqual(post.call_args.kwargs["files"]["image"][1], raw)
        self.assertEqual((result.data["width"], result.data["height"]), (1024, 1024))
        self.assertEqual(result.data["sourceHash"], source["hash"])

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
        request = {"runId": run_id, "accessToken": "test-token", "prompt": "Make it red", "size": "auto", "operation": "edit", "sourceImage": self.source}
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
    def test_selected_25_deployment_is_used_for_generation_and_edit(self, post):
        models = ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]
        self.settings.write_text(json.dumps({"image": {"endpoint": "https://test.invalid", "deployment": "gpt-image-2",
            "deployments": {model: model + "-deployment" for model in models}}}))
        post.return_value = self.response
        for model in models:
            for operation in ["generate", "edit"]:
                result = AzureImage("test-token").execute({"prompt": "test", "size": "1024x1024", "imageModel": model,
                    "operation": operation, **({"sourceImage": self.source} if operation == "edit" else {})})
                self.assertTrue(result.success)
                self.assertEqual(result.model, model + "-deployment")
                self.assertEqual(post.call_args.kwargs["data" if operation == "edit" else "json"]["model"], result.model)
                self.assertEqual(post.call_args.kwargs["headers"], {"Authorization": "Bearer test-token"})

    @patch("azure_image.requests.post")
    def test_missing_deployment_or_token_never_falls_back(self, post):
        result = AzureImage("test-token").execute({"prompt": "test", "size": "1024x1024", "imageModel": "gpt-image-2.5-flare"})
        self.assertFalse(result.success)
        self.assertIn("not configured", result.error)
        result = AzureImage("").execute({"prompt": "test", "size": "1024x1024"})
        self.assertFalse(result.success)
        self.assertIn("token unavailable", result.error)
        post.assert_not_called()

    @patch("azure_image.requests.post")
    def test_error_details_keep_codes_and_request_ids_without_secrets(self, post):
        response = Mock(status_code=400, headers={"apim-request-id": "request-123"})
        response.json.return_value = {"error": {"code": "invalid_request_error", "param": "size",
            "message": "Unsupported size; private prompt; Bearer test-token", "innererror": {"code": "InvalidSize"},
            "input": self.source}}
        post.return_value = response
        result = AzureImage("test-token").execute({"prompt": "private prompt", "size": "1024x1024", "operation": "edit", "sourceImage": self.source})
        self.assertFalse(result.success)
        for expected in ["edit HTTP 400", "invalid_request_error", "param=size", "Unsupported size", "InvalidSize", "request-123", "no automatic retry"]:
            self.assertIn(expected, result.error)
        for secret in ["test-token", "private prompt", self.source["png"]]:
            self.assertNotIn(secret, result.error)
        post.assert_called_once()

    @patch("azure_image.requests.post")
    def test_error_details_are_bounded_and_non_json_is_safe(self, post):
        response = Mock(status_code=502, headers={"x-request-id": "gateway-123"})
        response.json.side_effect = ValueError("HTML error page")
        post.return_value = response
        result = AzureImage("test-token").execute({"prompt": "test", "size": "1024x1024"})
        self.assertIn("HTTP 502", result.error)
        self.assertIn("gateway-123", result.error)
        response.json.side_effect = None
        response.json.return_value = {"error": {"message": "long error " * 2000, "innererror": {"message": "nested error " * 2000, "innererror": {"message": "deeper error " * 2000}}}}
        result = AzureImage("test-token").execute({"prompt": "test", "size": "1024x1024"})
        self.assertLessEqual(len(result.error), 3020)
        self.assertIn("long error", result.error)
        self.assertIn("gateway-123", result.error)

    @patch("azure_image.requests.post")
    def test_failed_edit_does_not_retry_or_fall_back(self, post):
        post.return_value = Mock(status_code=400)
        result = AzureImage("test-token").execute({"prompt": "Edit", "size": "1024x1024", "operation": "edit", "sourceImage": self.source})
        self.assertFalse(result.success)
        self.assertIn("edit HTTP 400", result.error)
        post.assert_called_once()


if __name__ == "__main__":
    unittest.main()