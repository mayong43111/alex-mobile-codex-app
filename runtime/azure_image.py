import base64
import hashlib
import io
import json
import os
import re
import sys
import time
from pathlib import Path

import requests
from PIL import Image
from tools.base_tool import BaseTool, ToolResult, ToolTier, ToolRuntime
from lib.checkpoint import write_checkpoint


def response_error(response, operation, secrets):
    def safe_text(value, limit=1200):
        if not isinstance(value, str):
            return ""
        for secret in secrets:
            if secret:
                value = value.replace(secret, "[redacted]")
        value = re.sub(r"(?i)(bearer\s+|api[-_ ]?key[\"'=:\s]+)\S+", "[redacted]", value)
        value = re.sub(r"[A-Za-z0-9_+/=-]{80,}", "[redacted]", value)
        return " ".join(value.split())[:limit]

    details = [f"Azure image {operation} HTTP {response.status_code}"]
    try:
        payload = response.json()
    except ValueError:
        payload = None
    error = payload.get("error", payload) if isinstance(payload, dict) else None
    for depth in range(3):
        if not isinstance(error, dict):
            break
        for field in ("code", "type", "param", "message"):
            value = safe_text(error.get(field), 1200 if field == "message" else 160)
            if value:
                details.append(f"{'inner.' * depth}{field}={value}")
        error = error.get("innererror", error.get("inner_error"))
    if len(details) == 1:
        details.append("error body unavailable or not structured JSON")
    summary = "; ".join(details)[:2400]
    request_ids = []
    for header in ("apim-request-id", "x-request-id", "x-ms-request-id"):
        value = safe_text(response.headers.get(header), 160)
        if value:
            request_ids.append(f"{header}={value}")
    return "; ".join([summary, *request_ids, "no automatic retry"])


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
            "size": {"type": "string", "pattern": "^(auto|[1-9][0-9]{0,4}x[1-9][0-9]{0,4})$"},
            "quality": {"enum": ["low", "medium", "high"]},
            "imageModel": {"enum": ["azure-image2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]},
            "operation": {"enum": ["generate", "edit"]},
            "sourceImage": {"type": "object", "required": ["assetId", "png", "hash", "width", "height"],
                "properties": {"assetId": {"type": "string"}, "png": {"type": "string", "maxLength": 66_666_668},
                    "hash": {"type": "string", "pattern": "^[0-9a-f]{64}$"}, "width": {"type": "integer"}, "height": {"type": "integer"}},
                "additionalProperties": False},
        },
        "additionalProperties": False,
    }
    input_schema['properties']['sourceImages'] = {
        'type': 'array', 'minItems': 1, 'maxItems': 10,
        'items': input_schema['properties']['sourceImage'],
    }

    def execute(self, inputs):
        import jsonschema

        jsonschema.validate(inputs, self.input_schema)
        if inputs['size'] != 'auto':
            width, height = map(int, inputs['size'].split('x'))
            if width % 16 or height % 16 or max(width, height) > 3840 or max(width, height) > 3 * min(width, height) or not 655360 <= width * height <= 8294400:
                return ToolResult(success=False, error='Unsupported output dimensions; image API not called')
        settings = json.loads(Path(os.environ["SERVICES_FILE"]).read_text())["image"]
        started = time.monotonic()
        try:
            if not isinstance(self.access_token, str) or not self.access_token.strip():
                return ToolResult(success=False, error="Azure image Entra token unavailable; image API not called")
            selected_model = inputs.get("imageModel", "azure-image2")
            deployment = settings["deployment"] if selected_model == "azure-image2" else settings.get("deployments", {}).get(selected_model)
            if not deployment:
                return ToolResult(success=False, error="Selected Azure image deployment is not configured; image API not called")
            operation = inputs.get("operation", "generate")
            sources = inputs.get('sourceImages', [inputs['sourceImage']] if inputs.get('sourceImage') else [])
            source = sources[0] if sources else None
            if inputs.get('sourceImage') and inputs['sourceImage'] != source:
                raise ValueError('Primary source mismatch')
            if len({item['assetId'] for item in sources}) != len(sources):
                raise ValueError('Duplicate source images')
            if (operation == "edit") != bool(source):
                raise ValueError("Editing requires a source image")
            body = {"model": deployment, "prompt": inputs["prompt"],
                    "size": inputs["size"], "quality": inputs.get("quality", "low"), "n": 1, "output_format": "png"}
            headers = {"Authorization": "Bearer " + self.access_token}
            endpoint = settings["endpoint"].rstrip("/") + "/openai/v1/images/"
            if source:
                files = []
                for index, reference in enumerate(sources):
                    original = base64.b64decode(reference['png'], validate=True)
                    if len(original) >= 50_000_000 or hashlib.sha256(original).hexdigest() != reference['hash']:
                        raise ValueError('Invalid source image')
                    with Image.open(io.BytesIO(original)) as original_image:
                        if original_image.format != 'PNG' or original_image.width * original_image.height > 40_000_000:
                            raise ValueError('Invalid source format or size')
                        original_image.load()
                        if original_image.size != (reference['width'], reference['height']):
                            raise ValueError('Invalid source dimensions')
                    files.append(('image[]', (f'source-{index + 1}.png', original, 'image/png')))
                response = requests.post(endpoint + "edits", headers=headers, data=body,
                    files=files if len(files) > 1 else {'image': ('source.png', files[0][1][1], 'image/png')}, timeout=(15, 240))
            else:
                response = requests.post(endpoint + "generations", headers=headers, json=body, timeout=(15, 240))
            if response.status_code != 200:
                return ToolResult(success=False, error=response_error(response, operation,
                    [self.access_token, inputs['prompt'], *[reference['png'] for reference in sources]]))
            payload = response.json()
            raw = base64.b64decode(payload["data"][0]["b64_json"], validate=True)
            if len(raw) > 32 * 1024 * 1024:
                raise ValueError("Image too large")
            image = Image.open(io.BytesIO(raw))
            if image.width * image.height > 40_000_000:
                raise ValueError("Image too large")
            image.load()
            expected = image.size if inputs["size"] == "auto" else tuple(int(value) for value in inputs["size"].split("x"))
            if image.size != expected or image.format != "PNG":
                raise ValueError("Unexpected image dimensions or format")
            return ToolResult(success=True, data={"png": base64.b64encode(raw).decode(),
                "width": image.width, "height": image.height, "usage": payload.get("usage"),
                "cost_status": "unknown", "provider": "azure", "operation": operation, "imageModel": selected_model,
                **({"sourceAssetId": source["assetId"], "sourceHash": source["hash"]} if source else {})}, model=deployment,
                duration_seconds=time.monotonic() - started, cost_usd=None)
        except (requests.RequestException, ValueError, KeyError, IndexError, OSError):
            return ToolResult(success=False, error="Azure image response unavailable or invalid; billing outcome may be uncertain; no automatic retry")


def main():
    request = json.load(sys.stdin)
    from uuid import UUID

    run_id = str(UUID(request["runId"]))
    root = Path("/state/montage")
    result = AzureImage(request["accessToken"]).execute({"prompt": request["prompt"], "size": request["size"],
        "imageModel": request.get("imageModel", "azure-image2"),
        "quality": request.get("quality", "low"),
        "operation": request.get("operation", "generate"), **({"sourceImage": request["sourceImage"]} if request.get("sourceImage") else {}),
        **({'sourceImages': request['sourceImages']} if 'sourceImages' in request else {})})
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
        "provider": "azure", "resolution": f"{result.data['width']}x{result.data['height']}", "format": "png", "prompt": request["prompt"]}],
        "metadata": {"cost_status": "unknown", "quality": request.get("quality", "low"), "usage": result.data.get("usage"),
            "operation": result.data["operation"], "source_asset_id": result.data.get("sourceAssetId"), "source_hash": result.data.get("sourceHash")}}
    write_checkpoint(root, run_id, "assets", "completed", {"asset_manifest": manifest})
    print(json.dumps({"success": True, **result.data, "model": result.model, "checkpoint": f"{run_id}/checkpoint_assets.json"}))


if __name__ == "__main__":
    main()