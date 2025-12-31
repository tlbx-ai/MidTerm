#!/usr/bin/env python3
"""
Test video generation with corrected image pair (matching aspect ratios).
"""

import os
import sys
import time
import base64
from pathlib import Path

def main():
    from google import genai
    from google.genai import types
    from google.genai.types import GenerateVideosConfig
    from google.oauth2.service_account import Credentials

    project_id = os.environ.get("VERTEX_AI_PROJECT_ID")
    service_account_path = os.environ.get("VERTEX_AI_SERVICE_ACCOUNT_JSON")

    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
    credentials = Credentials.from_service_account_file(
        service_account_path,
        scopes=scopes
    )

    client = genai.Client(
        vertexai=True,
        project=project_id,
        location="us-central1",
        credentials=credentials,
    )

    # Use corrected images (both 16:9)
    first_frame = Path("output/advanced_test/step1_sitting.png")
    last_frame = Path("output/advanced_test/step2_standing_v2.png")
    output_path = Path("output/advanced_test/step3_dance_v2.mp4")

    if not first_frame.exists() or not last_frame.exists():
        print("ERROR: Required images not found")
        sys.exit(1)

    print(f"First frame: {first_frame}")
    print(f"Last frame: {last_frame}")
    print(f"Output: {output_path}")
    print()

    first_image = types.Image.from_file(location=str(first_frame))
    last_image = types.Image.from_file(location=str(last_frame))

    prompt = "The person smoothly transitions from sitting to standing while doing a celebratory dance move, continuous fluid motion, same office environment"

    print(f"Prompt: {prompt}")
    print()
    print("Generating video (2-3 minutes)...")

    operation = client.models.generate_videos(
        model="veo-3.1-generate-001",
        prompt=prompt,
        image=first_image,
        config=GenerateVideosConfig(
            aspect_ratio="16:9",
            duration_seconds=4,
            generate_audio=False,
            resolution="720p",
            last_frame=last_image,
        ),
    )

    poll_count = 0
    while not operation.done:
        poll_count += 1
        print(f"  Waiting... (poll #{poll_count})")
        time.sleep(15)
        operation = client.operations.get(operation)

    print()

    if operation.response:
        result = operation.result
        if result.generated_videos:
            video = result.generated_videos[0].video
            if hasattr(video, 'video_bytes') and video.video_bytes:
                video_bytes = video.video_bytes
                if isinstance(video_bytes, str):
                    video_bytes = base64.b64decode(video_bytes)
                with open(output_path, 'wb') as f:
                    f.write(video_bytes)
                print(f"SUCCESS! Saved: {output_path}")
                print(f"Size: {len(video_bytes)} bytes")
            elif hasattr(video, 'uri') and video.uri:
                print(f"SUCCESS! Video at GCS: {video.uri}")
            else:
                print("Video generated but no bytes found")
        else:
            print("No videos in result")
    else:
        print("Operation failed")
        if hasattr(operation, 'error'):
            print(f"Error: {operation.error}")


if __name__ == "__main__":
    main()
