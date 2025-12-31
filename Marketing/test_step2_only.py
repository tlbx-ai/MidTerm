#!/usr/bin/env python3
"""
Test just step 2: Generate variation of existing image using subject reference.
"""

import os
import sys
from pathlib import Path

def main():
    from google import genai
    from google.genai import types
    from google.genai.types import (
        EditImageConfig,
        SubjectReferenceConfig,
        SubjectReferenceImage,
    )
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

    # Use existing base image
    base_image_path = Path("output/advanced_test/step1_sitting.png")
    if not base_image_path.exists():
        print("ERROR: Run test_advanced_workflow.py first to generate base image")
        sys.exit(1)

    output_path = Path("output/advanced_test/step2_standing_v2.png")

    # Load the base image
    base_image = types.Image.from_file(location=str(base_image_path))
    print(f"Base image: {base_image_path}")
    print(f"  Bytes: {len(base_image.image_bytes)}")
    print(f"  MIME: {base_image.mime_type}")
    print()

    # Create subject reference
    subject_ref = SubjectReferenceImage(
        reference_id=1,
        reference_image=base_image,
        config=SubjectReferenceConfig(
            subject_description="person with short dark hair sitting at desk",
            subject_type="SUBJECT_TYPE_PERSON",
        ),
    )

    prompt = "The same person [1] now standing next to the desk with arms raised celebrating, same office environment, same lighting, photorealistic"

    print(f"Prompt: {prompt}")
    print()
    print("Generating with subject reference...")

    try:
        response = client.models.edit_image(
            model="imagen-3.0-capability-001",
            prompt=prompt,
            reference_images=[subject_ref],
            config=EditImageConfig(
                edit_mode="EDIT_MODE_DEFAULT",
                number_of_images=1,
                aspect_ratio="16:9",
                person_generation="ALLOW_ADULT",
            ),
        )

        if response.generated_images:
            response.generated_images[0].image.save(str(output_path))
            print(f"SUCCESS! Saved: {output_path}")
            print(f"Size: {len(response.generated_images[0].image.image_bytes)} bytes")
        else:
            print("No images generated")

    except Exception as e:
        print(f"ERROR: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    main()
