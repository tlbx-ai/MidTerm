/**
 * Smart Input Module
 *
 * Floating text input overlay for mobile devices.
 * Prevents on-screen keyboard from appearing by keeping
 * terminal unfocused while providing a text input + mic button.
 */

export { initSmartInput, showSmartInput, hideSmartInput, isSmartInputMode } from './smartInput';
export { startTranscription, stopTranscription } from './transcription';
