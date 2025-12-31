#!/usr/bin/env python3
"""
Hello World - Veo Video Generation via Vertex AI
Uses Google's Veo model to generate videos from text prompts.

Environment variables required:
  VERTEX_AI_PROJECT_ID - Google Cloud project ID
  VERTEX_AI_SERVICE_ACCOUNT_JSON - Path to service account JSON file

Optional:
  VERTEX_AI_GCS_BUCKET - GCS bucket for output (e.g., gs://my-bucket/videos)
                         If not set, video bytes are returned directly.

Usage:
  python generate_video.py "A terminal with scrolling code" output.mp4
  python generate_video.py  # Uses default prompt
"""

import os
import sys
import time
import base64
from pathlib import Path

def main():
    from google import genai
    from google.genai.types import GenerateVideosConfig
    from google.oauth2.service_account import Credentials

    # Get configuration from environment
    project_id = os.environ.get("VERTEX_AI_PROJECT_ID")
    service_account_path = os.environ.get("VERTEX_AI_SERVICE_ACCOUNT_JSON")
    gcs_bucket = os.environ.get("VERTEX_AI_GCS_BUCKET")

    if not project_id:
        print("ERROR: VERTEX_AI_PROJECT_ID environment variable not set")
        sys.exit(1)
    if not service_account_path:
        print("ERROR: VERTEX_AI_SERVICE_ACCOUNT_JSON environment variable not set")
        sys.exit(1)
    if not Path(service_account_path).exists():
        print(f"ERROR: Service account file not found: {service_account_path}")
        sys.exit(1)

    # Parse arguments
    prompt = sys.argv[1] if len(sys.argv) > 1 else "A modern terminal application with glowing green text scrolling on a dark background, cinematic"
    output_file = sys.argv[2] if len(sys.argv) > 2 else "output_video.mp4"

    print(f"Project ID: {project_id}")
    print(f"Service Account: {service_account_path}")
    print(f"GCS Bucket: {gcs_bucket or '(none - will return bytes directly)'}")
    print(f"Prompt: {prompt}")
    print(f"Output: {output_file}")
    print()

    # Create credentials from service account file
    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
    credentials = Credentials.from_service_account_file(
        service_account_path,
        scopes=scopes
    )

    # Initialize the client with Vertex AI
    client = genai.Client(
        vertexai=True,
        project=project_id,
        location="us-central1",
        credentials=credentials,
    )

    print("Starting video generation (this may take a few minutes)...")

    # Build config - using smallest settings for testing
    # Veo 3 duration: 4, 6, or 8 seconds
    # Resolution: "720p" (default) or "1080p"
    config_params = {
        "aspect_ratio": "16:9",
        "duration_seconds": 4,  # smallest
        "generate_audio": False,  # save cost
        "resolution": "720p",  # smallest
    }

    # If GCS bucket is provided, use it for output
    if gcs_bucket:
        config_params["output_gcs_uri"] = gcs_bucket

    # Generate video using Veo
    # Models: veo-3.1-generate-001 (supports first+last frame), veo-3.0-generate-preview
    operation = client.models.generate_videos(
        model="veo-3.1-generate-001",
        prompt=prompt,
        config=GenerateVideosConfig(**config_params),
    )

    # Poll until complete
    poll_count = 0
    while not operation.done:
        poll_count += 1
        print(f"  Waiting... (poll #{poll_count})")
        time.sleep(15)
        operation = client.operations.get(operation)

    print()

    # Handle result
    if operation.response:
        result = operation.result
        if result.generated_videos:
            video = result.generated_videos[0].video

            if hasattr(video, 'uri') and video.uri:
                # Video was saved to GCS
                print(f"Video saved to GCS: {video.uri}")
                print(f"Download from GCS to get the video file.")
            elif hasattr(video, 'video_bytes') and video.video_bytes:
                # Video bytes returned directly
                video_bytes = video.video_bytes
                if isinstance(video_bytes, str):
                    video_bytes = base64.b64decode(video_bytes)
                with open(output_file, 'wb') as f:
                    f.write(video_bytes)
                print(f"Video saved to: {output_file}")
                print(f"Video size: {len(video_bytes)} bytes")
            else:
                print("Video generated but no bytes or URI found")
                print(f"Video object attributes: {dir(video)}")
        else:
            print("ERROR: No videos in result")
            sys.exit(1)
    else:
        print(f"ERROR: Operation failed")
        if hasattr(operation, 'error'):
            print(f"Error: {operation.error}")
        sys.exit(1)


if __name__ == "__main__":
    main()
