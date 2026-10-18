import { refreshVoiceAvailability } from '../voice';

interface AiSettings {
  providers: { id: string; configured: boolean; keyPreview: string | null }[];
  workerModel: string;
  workerModels: { id: string; name: string; provider: string }[];
}
let bound = false;

async function request(path: string, body?: unknown): Promise<AiSettings> {
  const response = await fetch(
    `/api/ai/${path}`,
    body === undefined
      ? {}
      : {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  if (!response.ok) throw new Error(`AI settings could not be saved (${response.status})`);
  return (await response.json()) as AiSettings;
}

function render(settings: AiSettings): void {
  for (const provider of settings.providers) {
    const status = document.getElementById(`ai-key-status-${provider.id}`);
    if (status)
      status.textContent = provider.configured
        ? `Key saved${provider.keyPreview ? ` · ${provider.keyPreview}` : ''}`
        : 'No key configured';
    const remove = document.getElementById(
      `ai-key-remove-${provider.id}`,
    ) as HTMLButtonElement | null;
    if (remove) remove.disabled = !provider.configured;
  }
  const model = document.getElementById('ai-worker-model') as HTMLSelectElement | null;
  if (model) {
    model.replaceChildren(
      ...settings.workerModels.map((m) => new Option(`${m.name} · ${m.provider}`, m.id)),
    );
    model.value = settings.workerModel;
  }
}

async function update(path: string, body: unknown): Promise<void> {
  const status = document.getElementById('ai-settings-status');
  try {
    render(await request(path, body));
    await refreshVoiceAvailability();
    if (status) status.textContent = 'Saved. New voice sessions use these settings.';
  } catch (error) {
    if (status) status.textContent = String(error);
  }
}

export async function initAiProviderSettings(): Promise<void> {
  if (!bound) {
    bound = true;
    for (const provider of ['openai', 'google', 'anthropic', 'xai']) {
      document.getElementById(`ai-key-save-${provider}`)?.addEventListener('click', () => {
        const input = document.getElementById(`ai-key-${provider}`) as HTMLInputElement | null;
        const key = input?.value.trim();
        if (!key) return;
        if (input) input.value = '';
        void update(`providers/${provider}`, { apiKey: key });
      });
      document.getElementById(`ai-key-remove-${provider}`)?.addEventListener('click', () => {
        void update(`providers/${provider}`, { apiKey: null });
      });
    }
    document.getElementById('ai-worker-model')?.addEventListener('change', (event) => {
      void update('settings', { workerModel: (event.target as HTMLSelectElement).value });
    });
  }
  try {
    render(await request('settings'));
  } catch {
    const status = document.getElementById('ai-settings-status');
    if (status) status.textContent = 'AI settings unavailable';
  }
}
