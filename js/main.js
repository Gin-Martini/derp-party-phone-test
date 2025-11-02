import * as WS from './ws.js?v=11.0.12';
import { renderCatalog } from './features/catalog.js?v=11.0.12';
import { state } from './state.js?v=11.0.12';
import {
  initUi
} from './ui.js?v=11.0.12';
import { onSocketMessage } from './router.js?v=11.0.12';
import { wireRollButton, updateRollUI, hideRollOverlay } from './features/rollOverlay.js?v=11.0.12';
import { configureSessionControls } from './features/sessionControls.js?v=11.0.12';
import { setupReadyButton } from './features/readyButton.js?v=11.0.12';

WS.setOnSocketMessage(onSocketMessage);

function renderInitialCatalog() {
  const list = Array.isArray(state._pendingCatalog)
    ? state._pendingCatalog
    : Array.isArray(state.catalog?.entries)
      ? state.catalog.entries
      : [];
  renderCatalog(list);
}

function boot() {
  initUi();
  wireRollButton();
  hideRollOverlay();
  updateRollUI();
  renderInitialCatalog();
  setupReadyButton();
  configureSessionControls();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
