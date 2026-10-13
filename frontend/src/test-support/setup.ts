import { vi } from 'vitest';

Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn((query: string) => ({
  matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
})) });

// jsdom does not implement the native modal lifecycle. Keyboard containment and
// background inertness are verified in Chromium, not simulated by this shim.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
}
