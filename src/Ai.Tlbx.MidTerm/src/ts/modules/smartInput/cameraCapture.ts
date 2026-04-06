export async function captureImageFromWebcam(
  onCapturedFiles: (files: FileList) => void | Promise<void>,
): Promise<void> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch {
    return;
  }

  const captureOverlay = document.createElement('div');
  captureOverlay.className = 'camera-capture-overlay';

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.srcObject = stream;

  const controls = document.createElement('div');
  controls.className = 'camera-capture-controls';

  const snapBtn = document.createElement('button');
  snapBtn.className = 'camera-capture-snap';
  snapBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg>';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'camera-capture-cancel';
  cancelBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';

  controls.appendChild(snapBtn);
  controls.appendChild(cancelBtn);
  captureOverlay.appendChild(video);
  captureOverlay.appendChild(controls);
  document.body.appendChild(captureOverlay);

  const cleanup = (): void => {
    for (const track of stream.getTracks()) {
      track.stop();
    }
    captureOverlay.remove();
  };

  cancelBtn.addEventListener('click', cleanup);
  captureOverlay.addEventListener('click', (event) => {
    if (event.target === captureOverlay) {
      cleanup();
    }
  });

  snapBtn.addEventListener('click', () => {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) {
      cleanup();
      return;
    }

    context.drawImage(video, 0, 0);
    cleanup();

    canvas.toBlob((blob) => {
      if (!blob) {
        return;
      }

      const now = new Date();
      const timestamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const file = new File([blob], `photo_${timestamp}.png`, { type: 'image/png' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      void onCapturedFiles(transfer.files);
    }, 'image/png');
  });
}
