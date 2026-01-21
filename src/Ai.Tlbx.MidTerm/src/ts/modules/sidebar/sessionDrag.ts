/**
 * Session Drag-and-Drop Module
 *
 * Handles drag-and-drop reordering of sidebar session items.
 */

import { dom } from '../../state';
import { reorderSessions, $sessionList } from '../../stores';
import { persistSessionOrder } from '../comms/stateChannel';

let draggedSessionId: string | null = null;
let draggedElement: HTMLElement | null = null;
let dropIndicatorPosition: 'above' | 'below' | null = null;
let dragImageElement: HTMLElement | null = null;
let dragStartedFromHandle = false;

// Track elements with active drop indicators (avoids full DOM scan)
const activeIndicators = new Set<HTMLElement>();

/**
 * Initialize drag-and-drop for the session list
 */
export function initSessionDrag(): void {
  const sessionList = dom.sessionList;
  if (!sessionList) return;

  // Track mousedown on drag handles to know if drag started from handle
  sessionList.addEventListener('mousedown', (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    dragStartedFromHandle = !!target.closest('.drag-handle');
  });

  sessionList.addEventListener('dragstart', handleDragStart);
  sessionList.addEventListener('dragend', handleDragEnd);
  sessionList.addEventListener('dragover', handleDragOver);
  sessionList.addEventListener('dragleave', handleDragLeave);
  sessionList.addEventListener('drop', handleDrop);
}

function handleDragStart(e: DragEvent): void {
  const target = e.target as HTMLElement;
  const sessionItem = target.closest('.session-item') as HTMLElement;
  if (!sessionItem) return;

  // Only allow drag from handle (tracked via mousedown)
  if (!dragStartedFromHandle) {
    e.preventDefault();
    return;
  }

  draggedSessionId = sessionItem.dataset.sessionId ?? null;
  draggedElement = sessionItem;

  sessionItem.classList.add('dragging');

  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggedSessionId ?? '');

    // Create a custom drag image (clone of the item)
    const dragImage = sessionItem.cloneNode(true) as HTMLElement;
    dragImage.style.position = 'absolute';
    dragImage.style.top = '-1000px';
    dragImage.style.opacity = '0.9';
    dragImage.style.transform = 'scale(0.95)';
    dragImage.style.width = sessionItem.offsetWidth + 'px';
    dragImage.classList.remove('dragging');
    document.body.appendChild(dragImage);
    e.dataTransfer.setDragImage(dragImage, 20, sessionItem.offsetHeight / 2);

    // Keep drag image until drag ends - some browsers need it to persist
    dragImageElement = dragImage;
  }
}

function handleDragEnd(_e: DragEvent): void {
  if (draggedElement) {
    draggedElement.classList.remove('dragging');
  }

  // Clean up drag image
  if (dragImageElement) {
    dragImageElement.remove();
    dragImageElement = null;
  }

  clearAllDropIndicators();

  draggedSessionId = null;
  draggedElement = null;
  dropIndicatorPosition = null;
  dragStartedFromHandle = false;
}

function handleDragOver(e: DragEvent): void {
  e.preventDefault();

  if (!draggedSessionId) return;

  const target = e.target as HTMLElement;
  const sessionItem = target.closest('.session-item') as HTMLElement;

  if (!sessionItem || sessionItem === draggedElement) {
    clearAllDropIndicators();
    return;
  }

  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'move';
  }

  const rect = sessionItem.getBoundingClientRect();
  const midY = rect.top + rect.height / 2;
  const isAbove = e.clientY < midY;

  clearAllDropIndicators();

  sessionItem.classList.add('drag-over');
  activeIndicators.add(sessionItem);
  if (isAbove) {
    sessionItem.classList.add('drag-over-above');
    dropIndicatorPosition = 'above';
  } else {
    sessionItem.classList.add('drag-over-below');
    dropIndicatorPosition = 'below';
  }
}

function handleDragLeave(e: DragEvent): void {
  const target = e.target as HTMLElement;
  const sessionItem = target.closest('.session-item') as HTMLElement;

  if (sessionItem) {
    const relatedTarget = e.relatedTarget as HTMLElement;
    if (!relatedTarget || !sessionItem.contains(relatedTarget)) {
      sessionItem.classList.remove('drag-over', 'drag-over-above', 'drag-over-below');
      activeIndicators.delete(sessionItem);
    }
  }
}

function handleDrop(e: DragEvent): void {
  e.preventDefault();

  if (!draggedSessionId) return;

  const target = e.target as HTMLElement;
  const targetItem = target.closest('.session-item') as HTMLElement;

  if (!targetItem || targetItem === draggedElement) return;

  const targetSessionId = targetItem.dataset.sessionId;
  if (!targetSessionId) return;

  const sessions = $sessionList.get();
  const fromIndex = sessions.findIndex((s) => s.id === draggedSessionId);
  let toIndex = sessions.findIndex((s) => s.id === targetSessionId);

  if (fromIndex === -1 || toIndex === -1) return;

  // Adjust toIndex based on drop position
  if (dropIndicatorPosition === 'below') {
    toIndex = fromIndex < toIndex ? toIndex : toIndex + 1;
  } else {
    toIndex = fromIndex > toIndex ? toIndex : toIndex - 1;
  }

  // Clamp to valid range
  toIndex = Math.max(0, Math.min(sessions.length - 1, toIndex));

  reorderSessions(fromIndex, toIndex);
  clearAllDropIndicators();

  // Persist new order to server
  const newOrder = $sessionList.get().map((s) => s.id);
  persistSessionOrder(newOrder);
}

function clearAllDropIndicators(): void {
  activeIndicators.forEach((item) => {
    item.classList.remove('drag-over', 'drag-over-above', 'drag-over-below');
  });
  activeIndicators.clear();
}
