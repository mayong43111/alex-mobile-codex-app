import base64
import hashlib
import io
import json
import os
import sys
import time
from pathlib import Path

import requests
from PIL import Image
from tools.base_tool import BaseTool, ToolResult, ToolTier, ToolRuntime
from lib.checkpoint import write_checkpoint


class AzureImage(BaseTool):
    name = "azure_image2"
    provider = "azure"
    capability = "image_generation"
    tier = ToolTier.GENERATE
    runtime = ToolRuntime.API
    fallback_tools = []
    def __init__(self, access_token):
        self.access_token = access_token

    input_schema = {
        "type": "object",
        "required": ["prompt", "size"],
        "properties": {
            "prompt": {"type": "string", "minLength": 1, "maxLength": 6000},
            "size": {"enum": ["1024x1024", "1536x1024", "1024x1536"]},
            "operation": {"enum": ["generate", "edit"]},
            "sourceImage": {"type": "object", "required": ["assetId", "png", "hash", "width", "height"],
                "properties": {"assetId": {"type": "string"}, "png": {"type": "string", "maxLength": 48 * 1024 * 1024},
                    "hash": {"type": "string", "pattern": "^[0-9a-f]{64}$"}, "width": {"type": "integer"}, "height": {"type": "integer"}},
                "additionalProperties": False},
        },
        "additionalProperties": False,
    }

    def execute(self, inputs):
        import jsonschema

        jsonschema.validate(inputs, self.input_schema)
        settings = json.loads(Path(os.environ["SERVICES_FILE"]).read_text())["image"]
        started = time.monotonic()
        try:
            operation = inputs.get("operation", "generate")
            source = inputs.get("sourceImage")
            if (operation == "edit") != bool(source):
                raise ValueError("Editing requires a source image")
            body = {"model": settings["deployment"], "prompt": inputs["prompt"],
                    "size": inputs["size"], "quality": "low", "n": 1, "output_format": "png"}
            headers = {"Authorization": "Bearer " + self.access_token}
            endpoint = settings["endpoint"].rstrip("/") + "/openai/v1/images/"
            if source:
                original = base64.b64decode(source["png"], validate=True)
                if len(original) > 32 * 1024 * 1024 or hashlib.sha256(original).hexdigest() != source["hash"]:
                    raise ValueError("Invalid source image")
                with Image.open(io.BytesIO(original)) as original_image:
                    if original_image.format != "PNG" or original_image.width * original_image.height > 40_000_000:
                        raise ValueError("Invalid source format or size")
                    original_image.load()
                    if original_image.size != (source["width"], source["height"]):
                        raise ValueError("Invalid source dimensions")
                response = requests.post(endpoint + "edits", headers=headers, data=body,
                    files={"image": ("source.png", original, "image/png")}, timeout=(15, 240))
            else:
                response = requests.post(endpoint + "generations", headers=headers, json=body, timeout=(15, 240))
            if response.status_code != 200:
                return ToolResult(success=False, error=f"Azure image {operation} HTTP {response.status_code}; no automatic retry")
            payload = response.json()
            raw = base64.b64decode(payload["data"][0]["b64_json"], validate=True)
            if len(raw) > 32 * 1024 * 1024:
                raise ValueError("Image too large")
            image = Image.open(io.BytesIO(raw))
            image.load()
            expected = tuple(int(value) for value in inputs["size"].split("x"))
            if image.size != expected or image.format != "PNG":
                raise ValueError("Unexpected image dimensions or format")
            return ToolResult(success=True, data={"png": base64.b64encode(raw).decode(),
                "width": image.width, "height": image.height, "usage": payload.get("usage"),
                "cost_status": "unknown", "provider": "azure", "operation": operation,
                **({"sourceAssetId": source["assetId"], "sourceHash": source["hash"]} if source else {})}, model=settings["deployment"],
                duration_seconds=time.monotonic() - started, cost_usd=None)
        except (requests.RequestException, ValueError, KeyError, IndexError, OSError):
            return ToolResult(success=False, error="Azure image response unavailable or invalid; billing outcome may be uncertain; no automatic retry")


def main():
    request = json.load(sys.stdin)
    from uuid import UUID

    run_id = str(UUID(request["runId"]))
    root = Path("/state/montage")
    result = AzureImage(request["accessToken"]).execute({"prompt": request["prompt"], "size": request["size"],
        "operation": request.get("operation", "generate"), **({"sourceImage": request["sourceImage"]} if request.get("sourceImage") else {})})
    if not result.success:
        write_checkpoint(root, run_id, "assets", "failed", {}, error=result.error)
        print(json.dumps({"success": False, "error": result.error}))
        return
    project = root / run_id
    project.mkdir(parents=True, exist_ok=True)
    output = project / "image.png"
    output.write_bytes(base64.b64decode(result.data["png"]))
    manifest = {"version": "1.0", "assets": [{"id": run_id, "type": "image", "path": "image.png",
        "source_tool": "azure_image2", "scene_id": "single", "model": result.model,
        "provider": "azure", "resolution": request["size"], "format": "png", "prompt": request["prompt"]}],
        "metadata": {"cost_status": "unknown", "usage": result.data.get("usage"),
            "operation": result.data["operation"], "source_asset_id": result.data.get("sourceAssetId"), "source_hash": result.data.get("sourceHash")}}
    write_checkpoint(root, run_id, "assets", "completed", {"asset_manifest": manifest})
    print(json.dumps({"success": True, **result.data, "model": result.model, "checkpoint": f"{run_id}/checkpoint_assets.json"}))


if __name__ == "__main__":
    main()