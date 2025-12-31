# MiddleManager Marketing Assets

AI-generated images and videos for social media marketing using Google Vertex AI.

## Setup

1. Install Python dependencies:
   ```bash
   pip install -r requirements.txt
   ```

2. Set environment variables:
   ```powershell
   $env:VERTEX_AI_PROJECT_ID = "your-project-id"
   $env:VERTEX_AI_SERVICE_ACCOUNT_JSON = "C:\path\to\service-account.json"
   ```

## Scripts

### generate_image.py - Imagen 3

Generate images from text prompts.

```bash
python generate_image.py "A terminal with glowing text" output.png
```

**Model:** `imagen-3.0-generate-002`
**Options:** 1:1, 3:4, 4:3, 16:9, 9:16 aspect ratios

### generate_video.py - Veo 3.1

Generate videos from text prompts.

```bash
python generate_video.py "A terminal with scrolling code" output.mp4
```

**Model:** `veo-3.1-generate-001`
**Duration:** 4, 6, or 8 seconds
**Resolution:** 720p or 1080p

### test_advanced_workflow.py - Full Pipeline

Tests the complete creative workflow:
1. Generate base image (person sitting at desk)
2. Generate variation using subject reference (same person, now standing)
3. Generate transition video with first+last frame (dancing animation)

```bash
python test_advanced_workflow.py
```

## Proven Capabilities

### Subject Customization (Imagen)
- Use `SubjectReferenceImage` with `subject_type="SUBJECT_TYPE_PERSON"`
- Reference in prompt with `[1]` notation
- Model: `imagen-3.0-capability-001`

### First+Last Frame Video (Veo)
- Provide `image` parameter for first frame
- Provide `last_frame` in config for end frame
- Model: `veo-3.1-generate-001` (required for this feature)

## Output Files

After running `test_advanced_workflow.py`:
```
output/advanced_test/
  step1_sitting.png      # Base image
  step2_standing.png     # Variation with subject reference
  step3_dance_transition.mp4  # Transition video
```

## API Reference

- [Imagen API](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/image/generate-images)
- [Subject Customization](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/image/subject-customization)
- [Veo First+Last Frame](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/video/generate-videos-from-first-and-last-frames)
