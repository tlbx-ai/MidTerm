#!/usr/bin/env python3
"""
Advanced Workflow Test: Person at desk -> Person standing -> Dancing transition video

Steps:
1. Generate base image (person sitting at desk)
2. Use subject reference to generate variation (person standing next to desk)
3. Use both images as first/last frame for Veo video (dancing transition)

Environment variables required:
  VERTEX_AI_PROJECT_ID - Google Cloud project ID
  VERTEX_AI_SERVICE_ACCOUNT_JSON - Path to service account JSON file
"""

import os
import sys
import time
import base64
from pathlib import Path

def setup_client():
    """Initialize the Google GenAI client with service account credentials."""
    from google import genai
    from google.oauth2.service_account import Credentials

    project_id = os.environ.get("VERTEX_AI_PROJECT_ID")
    service_account_path = os.environ.get("VERTEX_AI_SERVICE_ACCOUNT_JSON")

    if not project_id or not service_account_path:
        print("ERROR: Missing environment variables")
        sys.exit(1)

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

    return client


def step1_generate_base_image(client, output_dir: Path):
    """Generate base image: person sitting at a desk."""
    from google.genai.types import GenerateImagesConfig

    print("=" * 60)
    print("STEP 1: Generate base image (person sitting at desk)")
    print("=" * 60)

    prompt = "A young professional person with short dark hair sitting at a modern desk with a laptop, looking at the screen, office environment, warm lighting, photorealistic"

    print(f"Prompt: {prompt}")
    print("Generating...")

    response = client.models.generate_images(
        model="imagen-3.0-generate-002",
        prompt=prompt,
        config=GenerateImagesConfig(
            number_of_images=1,
            aspect_ratio="16:9",  # Good for video later
            person_generation="ALLOW_ADULT",
        ),
    )

    if not response.generated_images:
        print("ERROR: No image generated")
        sys.exit(1)

    output_path = output_dir / "step1_sitting.png"
    response.generated_images[0].image.save(str(output_path))
    print(f"Saved: {output_path}")
    print(f"Size: {len(response.generated_images[0].image.image_bytes)} bytes")

    return output_path


def step2_generate_variation(client, base_image_path: Path, output_dir: Path):
    """Generate variation: same person standing next to the desk."""
    from google.genai import types
    from google.genai.types import (
        EditImageConfig,
        SubjectReferenceConfig,
        SubjectReferenceImage,
    )

    print()
    print("=" * 60)
    print("STEP 2: Generate variation (same person, now standing)")
    print("=" * 60)

    # Load the base image (from_file takes keyword argument)
    base_image = types.Image.from_file(location=str(base_image_path))
    print(f"Base image loaded: {len(base_image.image_bytes)} bytes, mime: {base_image.mime_type}")

    # Create subject reference from the base image
    subject_ref = SubjectReferenceImage(
        reference_id=1,
        reference_image=base_image,
        config=SubjectReferenceConfig(
            subject_description="a young professional person with short dark hair",
            subject_type="SUBJECT_TYPE_PERSON",
        ),
    )

    # Prompt must reference [1] to use the subject
    prompt = "The same person [1] now standing next to the desk with arms raised in a celebratory pose, same office environment, warm lighting, photorealistic"

    print(f"Prompt: {prompt}")
    print("Generating with subject reference...")

    try:
        response = client.models.edit_image(
            model="imagen-3.0-capability-001",
            prompt=prompt,
            reference_images=[subject_ref],
            config=EditImageConfig(
                edit_mode="EDIT_MODE_DEFAULT",
                number_of_images=1,
                aspect_ratio="16:9",  # Match the first image
                person_generation="ALLOW_ADULT",
            ),
        )

        if not response.generated_images:
            print("ERROR: No image generated")
            sys.exit(1)

        output_path = output_dir / "step2_standing.png"
        response.generated_images[0].image.save(str(output_path))
        print(f"Saved: {output_path}")
        print(f"Size: {len(response.generated_images[0].image.image_bytes)} bytes")

        return output_path

    except Exception as e:
        print(f"ERROR with subject reference: {e}")
        print()
        print("Falling back to text-only generation (similar prompt)...")

        # Fallback: generate similar image without subject reference
        from google.genai.types import GenerateImagesConfig

        fallback_prompt = "A young professional person with short dark hair standing next to a modern desk with arms raised in a celebratory pose, laptop on desk, office environment, warm lighting, photorealistic"

        response = client.models.generate_images(
            model="imagen-3.0-generate-002",
            prompt=fallback_prompt,
            config=GenerateImagesConfig(
                number_of_images=1,
                aspect_ratio="16:9",
                person_generation="ALLOW_ADULT",
            ),
        )

        if not response.generated_images:
            print("ERROR: Fallback also failed")
            sys.exit(1)

        output_path = output_dir / "step2_standing.png"
        response.generated_images[0].image.save(str(output_path))
        print(f"Saved (fallback): {output_path}")

        return output_path


def step3_generate_video(client, first_frame: Path, last_frame: Path, output_dir: Path):
    """Generate transition video with dancing animation."""
    from google.genai import types
    from google.genai.types import GenerateVideosConfig

    print()
    print("=" * 60)
    print("STEP 3: Generate transition video (dancing animation)")
    print("=" * 60)

    # Load images (from_file takes keyword argument)
    first_image = types.Image.from_file(location=str(first_frame))
    last_image = types.Image.from_file(location=str(last_frame))

    prompt = "The person smoothly transitions from sitting to standing while doing a celebratory dance, energetic movement, office setting"

    print(f"First frame: {first_frame}")
    print(f"Last frame: {last_frame}")
    print(f"Prompt: {prompt}")
    print("Generating video (this takes a few minutes)...")

    try:
        # veo-3.1-generate-001 supports first+last frame feature
        # veo-2.0-generate-001 also supports it
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

        # Poll until complete
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

                # Try to get video bytes
                if hasattr(video, 'video_bytes') and video.video_bytes:
                    video_bytes = video.video_bytes
                    if isinstance(video_bytes, str):
                        video_bytes = base64.b64decode(video_bytes)
                    output_path = output_dir / "step3_dance_transition.mp4"
                    with open(output_path, 'wb') as f:
                        f.write(video_bytes)
                    print(f"Saved: {output_path}")
                    print(f"Size: {len(video_bytes)} bytes")
                    return output_path
                elif hasattr(video, 'uri') and video.uri:
                    print(f"Video saved to GCS: {video.uri}")
                    return video.uri
                else:
                    print("Video generated but couldn't extract bytes")
                    print(f"Video attrs: {dir(video)}")
            else:
                print("ERROR: No videos in result")
        else:
            print("ERROR: Operation failed")
            if hasattr(operation, 'error'):
                print(f"Error: {operation.error}")

    except Exception as e:
        print(f"ERROR: {e}")
        import traceback
        traceback.print_exc()

    return None


def main():
    print("=" * 60)
    print("ADVANCED WORKFLOW TEST")
    print("Person sitting -> Person standing -> Dancing transition")
    print("=" * 60)
    print()

    # Setup
    client = setup_client()
    output_dir = Path("output/advanced_test")
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Output directory: {output_dir}")
    print()

    # Step 1: Generate base image
    base_image = step1_generate_base_image(client, output_dir)

    # Step 2: Generate variation
    variation_image = step2_generate_variation(client, base_image, output_dir)

    # Step 3: Generate video
    video = step3_generate_video(client, base_image, variation_image, output_dir)

    print()
    print("=" * 60)
    print("WORKFLOW COMPLETE")
    print("=" * 60)
    print(f"Base image: {base_image}")
    print(f"Variation: {variation_image}")
    print(f"Video: {video}")


if __name__ == "__main__":
    main()
