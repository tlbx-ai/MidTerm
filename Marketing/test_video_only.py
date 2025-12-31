#!/usr/bin/env python3
"""
Test just the video generation step with first/last frame.
Uses existing images from the advanced test.
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

    # Use existing images
    first_frame = Path("output/advanced_test/step1_sitting.png")
    last_frame = Path("output/advanced_test/step2_standing.png")
    output_path = Path("output/advanced_test/step3_dance_transition.mp4")

    if not first_frame.exists() or not last_frame.exists():
        print("ERROR: Run test_advanced_workflow.py first to generate images")
        sys.exit(1)

    print(f"First frame: {first_frame}")
    print(f"Last frame: {last_frame}")

    first_image = types.Image.from_file(location=str(first_frame))
    last_image = types.Image.from_file(location=str(last_frame))

    prompt = "The person smoothly transitions from sitting to standing while doing a celebratory dance, energetic movement, office setting"
    print(f"Prompt: {prompt}")
    print()

    # Try different models
    models_to_try = [
        "veo-3.1-generate-001",
        "veo-2.0-generate-001",
        "veo-3.1-generate-preview",
    ]

    for model in models_to_try:
        print(f"Trying model: {model}")
        try:
            operation = client.models.generate_videos(
                model=model,
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
                        print(f"Model that worked: {model}")
                        return
                    elif hasattr(video, 'uri') and video.uri:
                        print(f"SUCCESS! Video at GCS: {video.uri}")
                        print(f"Model that worked: {model}")
                        return
            print(f"  No video returned from {model}")

        except Exception as e:
            print(f"  Failed: {e}")
            continue

    print("All models failed")


if __name__ == "__main__":
    main()
