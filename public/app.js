const gallery = document.querySelector('#gallery');
const search = document.querySelector('#search');
const searchWrap = document.querySelector('#search-wrap');
const sourceCount = document.querySelector('#source-count');
const galleryNote = document.querySelector('#gallery-note');
const selectedTitle = document.querySelector('#selected-title');
const currentImage = document.querySelector('#current-image');
const emptyState = document.querySelector('#empty-state');
const generateButton = document.querySelector('#generate');
const pushButton = document.querySelector('#push-to-frame');
const aiPanel = document.querySelector('#ai-panel');
const aiProvider = document.querySelector('#ai-provider');
const aiGenerateButton = document.querySelector('#ai-generate');
const aiNote = document.querySelector('#ai-note');
const statusNote = document.querySelector('#status-note');
const toast = document.querySelector('#toast');
let category = 'uploads';
let movieSort = 'trending';
let items = [];
let selected = null;
let enabledAiProviders = {};
let searchTimer;
let toastTimer;

function notify(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3400);
}

async function request(url, options) {
  const response = await fetch(url, options);
  scheduleApiLogRefresh();
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || result.detail || 'Something went wrong.');
  return result;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function cardMarkup(item) {
  const isSelected = selected?.id === item.id;
  const title = item.filename || item.title;
  const deleteButton = item.type === 'upload'
    ? `<button class="delete-image" type="button" data-filename="${encodeURIComponent(item.filename)}" aria-label="Delete ${escapeHtml(title)}" title="Delete image">×</button>`
    : '';
  return `<div class="source-card${isSelected ? ' selected' : ''}" data-category="${category}"><button class="source-select" type="button" data-id="${encodeURIComponent(item.id)}" data-category="${category}" aria-label="Select ${escapeHtml(title)}" aria-pressed="${isSelected}"><div class="source-image-wrap"><img src="${escapeHtml(item.image)}" alt="" loading="lazy"><span class="selected-check">✓</span></div><span class="source-caption">${escapeHtml(title)}</span><span class="source-subtitle">${escapeHtml(item.subtitle || '')}</span></button>${deleteButton}</div>`;
}

function renderItems() {
  sourceCount.textContent = items.length ? `${items.length} IMAGES` : '';
  gallery.innerHTML = items.map(cardMarkup).join('');
  if (!items.length) {
    const empty = category === 'movies'
      ? '<strong>Movie posters, ready to roll.</strong><br>Add a TMDB API key in .env to browse current and trending releases.'
      : category === 'tv' ? '<strong>TV posters, ready to roll.</strong><br>Try searching for a show or browse current and trending series.'
      : category === 'museum' ? 'No artworks found. Try a broader search, like “landscape”.'
        : category === 'nature' ? 'No images found. Try another search.' : 'Images uploaded from your phone will appear here.';
    gallery.innerHTML = `<div class="gallery-message"><span class="message-mark">F</span><span>${empty}</span></div>`;
  }
}

async function loadItems() {
  if (category === 'ai') return;
  gallery.innerHTML = '<div class="gallery-message">Finding images…</div>';
  sourceCount.textContent = '';
  try {
    if (category === 'weather') {
      items = [{ id: 'weather-copenhagen', title: 'Copenhagen weather', subtitle: 'Live conditions · text overlay', image: '/display.png', type: 'weather' }];
      galleryNote.textContent = 'Weather, temperature and date are added to the image.';
    } else if (category === 'uploads') {
      items = await request('/api/uploads');
      galleryNote.textContent = 'Upload an image from this device or your phone.';
    } else {
      const result = await request(`/api/sources?category=${encodeURIComponent(category)}&sort=${movieSort}&q=${encodeURIComponent(search.value.trim())}`);
      items = result.items;
      galleryNote.textContent = category === 'movies' ? 'Trending movie posters · TMDB'
        : category === 'tv' ? 'Trending TV show posters · TMDB'
          : category === 'museum' ? 'Open-access collection · The Met' : 'Community imagery · Wikimedia Commons';
    }
    renderItems();
  } catch (error) {
    items = [];
    renderItems();
    galleryNote.textContent = error.message;
  }
}

async function loadStatus() {
  try {
    const status = await request('/api/status');
    document.querySelector('#connection-label').textContent = 'CONNECTED';
    document.querySelector('#generated-at').textContent = status.generatedAt
      ? `Last prepared ${new Date(status.generatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : 'Preparing first image';
    if (!status.ready) { emptyState.hidden = false; currentImage.hidden = true; }
    if (status.source?.type === 'weather') selected = { id: 'weather-copenhagen', title: 'Copenhagen weather', type: 'weather' };
    else if (status.source?.type === 'upload') selected = { id: `upload-${status.source.filename}`, filename: status.source.filename, title: status.source.title || 'Uploaded image', image: `/uploads/${encodeURIComponent(status.source.filename)}`, type: 'upload' };
    else if (status.source?.type === 'remote') selected = status.source;
    if (selected) { selectedTitle.textContent = selected.title || 'Selected image'; renderItems(); }
    document.querySelector('#dither-algorithm').value = status.processing?.dither || 'floyd-steinberg';
    document.querySelector('#exposure').value = status.processing?.exposure ?? 0;
    document.querySelector('#contrast').value = (status.processing?.contrast ?? 1) * 100;
    document.querySelector('#saturation').value = (status.processing?.saturation ?? 1) * 100;
    updateSliderValues();
    document.querySelector('#overlay-mode').value = status.overlay?.mode || 'weather';
    const providers = status.aiProviders || {};
    enabledAiProviders = providers;
    for (const option of aiProvider.options) {
      option.disabled = !providers[option.value];
    }
    const selectedProvider = [...aiProvider.options].find((option) => !option.disabled);
    if (selectedProvider) {
      aiProvider.value = selectedProvider.value;
      aiGenerateButton.disabled = false;
      aiNote.textContent = 'Generated images are saved in Your images and can be prepared or sent to the frame.';
    } else {
      aiGenerateButton.disabled = true;
      aiNote.textContent = 'Set OPENAI_API_KEY and/or GEMINI_API_KEY in .env, then restart the server to enable AI generation.';
    }
  } catch { document.querySelector('#connection-label').textContent = 'OFFLINE'; }
}

function updateSliderValues() {
  const exposure = Number(document.querySelector('#exposure').value);
  document.querySelector('#exposure-value').value = `${exposure > 0 ? '+' : ''}${exposure.toFixed(1)} EV`;
  document.querySelector('#contrast-value').value = `${document.querySelector('#contrast').value}%`;
  document.querySelector('#saturation-value').value = `${document.querySelector('#saturation').value}%`;
}

function currentProcessingSettings() {
  return {
    dither: document.querySelector('#dither-algorithm').value,
    exposure: Number(document.querySelector('#exposure').value),
    contrast: Number(document.querySelector('#contrast').value) / 100,
    saturation: Number(document.querySelector('#saturation').value) / 100,
  };
}

async function saveSettings() {
  await request('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      processing: currentProcessingSettings(),
      overlay: { mode: document.querySelector('#overlay-mode').value },
    }),
  });
}

async function preparePreview() {
  const result = await request('/api/generate', { method: 'POST' });
  currentImage.hidden = false;
  emptyState.hidden = true;
  currentImage.src = `/display.png?t=${Date.now()}`;
  document.querySelector('#generated-at').textContent = `Last prepared ${new Date(result.updatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
}

async function choose(item) {
  selected = item;
  renderItems();
  selectedTitle.textContent = item.title;
  const source = item.type === 'upload' ? { type: 'upload', filename: item.filename, title: item.title }
    : item.type === 'weather' ? { type: 'weather' }
      : { type: 'remote', id: item.id, title: item.title, image: item.image };
  try {
    await request('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source }) });
    statusNote.textContent = 'Saved. This image will be prepared at midnight Copenhagen time.';
    notify('Image source saved.');
    return true;
  } catch (error) { notify(error.message); return false; }
}

document.querySelectorAll('.slider-field input').forEach((slider) => {
  slider.addEventListener('input', updateSliderValues);
  slider.addEventListener('change', async () => {
    const note = document.querySelector('#settings-note');
    note.textContent = 'Saving settings and refreshing preview…';
    try {
      await saveSettings();
      await preparePreview();
      note.textContent = 'Saved. The preview reflects your slider settings.';
    } catch (error) {
      note.textContent = error.message;
      notify(error.message);
    }
  });
});

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((candidate) => {
    const active = candidate === tab;
    candidate.classList.toggle('active', active);
    candidate.setAttribute('aria-selected', String(active));
  });
  category = tab.dataset.category;
  document.querySelector('#movie-filters [data-sort="latest"]').textContent = category === 'tv' ? 'On the air' : 'Now playing';
  search.value = '';
  aiPanel.hidden = category !== 'ai';
  document.querySelector('.gallery-tools').hidden = category === 'ai';
  gallery.hidden = category === 'ai';
  document.querySelector('.gallery-footer').hidden = category === 'ai';
  searchWrap.hidden = category === 'uploads' || category === 'weather';
  document.querySelector('#file-input').parentElement.hidden = category === 'weather';
  document.querySelector('#movie-filters').hidden = !['movies', 'tv'].includes(category);
  loadItems();
}));

document.querySelector('#movie-filters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-sort]');
  if (!button) return;
  movieSort = button.dataset.sort;
  document.querySelectorAll('.movie-filter').forEach((filter) => {
    const active = filter === button;
    filter.classList.toggle('active', active);
    filter.setAttribute('aria-pressed', String(active));
  });
  loadItems();
});

search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadItems, 450); });
search.addEventListener('keydown', (event) => { if (event.key === 'Enter') loadItems(); });
gallery.addEventListener('click', (event) => {
  const deleteButton = event.target.closest('.delete-image');
  if (deleteButton) {
    const filename = decodeURIComponent(deleteButton.dataset.filename);
    if (!window.confirm(`Delete "${filename}" from your image library?`)) return;
    deleteButton.disabled = true;
    request(`/api/uploads/${encodeURIComponent(filename)}`, { method: 'DELETE' })
      .then(() => {
        items = items.filter((item) => item.filename !== filename);
        renderItems();
        notify('Image deleted.');
      })
      .catch((error) => notify(error.message))
      .finally(() => { deleteButton.disabled = false; });
    return;
  }
  const card = event.target.closest('.source-select');
  if (!card) return;
  const item = items.find((candidate) => candidate.id === decodeURIComponent(card.dataset.id));
  if (item) choose(item);
});

document.querySelector('#file-input').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const data = new FormData();
  data.append('image', file);
  try {
    const item = await request('/api/uploads', { method: 'POST', body: data });
    document.querySelector('[data-category="uploads"]').click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!await choose(item)) throw new Error('The generated image could not be selected.');
    notify('Image uploaded and selected.');
  } catch (error) { notify(error.message); }
  finally { event.target.value = ''; }
});

document.querySelector('#save-settings').addEventListener('click', async () => {
  const button = document.querySelector('#save-settings');
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    await saveSettings();
    await preparePreview();
    document.querySelector('#settings-note').textContent = 'Saved. The preview reflects your processing settings.';
    notify('Image processing settings saved.');
  } catch (error) {
    document.querySelector('#settings-note').textContent = error.message;
    notify(error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Save processing settings';
  }
});

aiGenerateButton.addEventListener('click', async () => {
  const prompt = document.querySelector('#ai-prompt').value.trim();
  aiGenerateButton.disabled = true;
  aiGenerateButton.textContent = 'Generating…';
  aiNote.textContent = 'Generating the image. This can take a minute.';
  try {
    const item = await request('/api/ai/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: aiProvider.value,
        orientation: document.querySelector('#ai-orientation').value,
        prompt,
      }),
    });
    await choose(item);
    const result = await request('/api/generate', { method: 'POST' });
    currentImage.hidden = false;
    emptyState.hidden = true;
    currentImage.src = `/display.png?t=${Date.now()}`;
    document.querySelector('#generated-at').textContent = `Last prepared ${new Date(result.updatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
    aiNote.textContent = 'Image generated, prepared for the frame, and saved in Your images.';
    notify('AI image generated and prepared.');
  } catch (error) {
    aiNote.textContent = error.message;
    notify(error.message);
  } finally {
    aiGenerateButton.disabled = !enabledAiProviders[aiProvider.value];
    aiGenerateButton.textContent = 'Generate image';
  }
});

generateButton.addEventListener('click', async () => {
  generateButton.disabled = true;
  generateButton.querySelector('span').textContent = 'Preparing…';
  statusNote.textContent = 'Formatting your image for the six-color display.';
  try {
    await preparePreview();
    statusNote.textContent = 'Ready at the fixed image URL.';
    notify('Display image is ready.');
  } catch (error) { statusNote.textContent = error.message; notify(error.message); }
  finally { generateButton.disabled = false; generateButton.querySelector('span').textContent = 'Prepare image now'; }
});

pushButton.addEventListener('click', async () => {
  pushButton.disabled = true;
  pushButton.textContent = 'Preparing and sending…';
  statusNote.textContent = 'Preparing the selected image and sending its pre-dithered EPDGZ data to the PhotoFrame.';
  try {
    await saveSettings();
    const result = await request('/api/push', { method: 'POST' });
    currentImage.hidden = false;
    emptyState.hidden = true;
    currentImage.src = `/display.png?t=${Date.now()}`;
    document.querySelector('#generated-at').textContent = `Last prepared ${new Date(result.updatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
    statusNote.textContent = 'Image sent to the PhotoFrame.';
    notify('Image sent to PhotoFrame.');
  } catch (error) { statusNote.textContent = error.message; notify(error.message); }
  finally { pushButton.disabled = false; pushButton.textContent = 'Send to PhotoFrame'; }
});

currentImage.addEventListener('error', () => { currentImage.hidden = true; emptyState.hidden = false; });

const apiEndpoints = {
  status: { method: 'GET', path: '/api/status' },
  'config-get': { method: 'GET', path: '/api/config' },
  'config-put': {
    method: 'PUT',
    path: '/api/config',
    body: { source: { type: 'weather' } },
  },
  'settings-put': {
    method: 'PUT',
    path: '/api/settings',
    body: {
      processing: { dither: 'floyd-steinberg', exposure: 0, contrast: 1, saturation: 1 },
      overlay: { mode: 'weather' },
    },
  },
  sources: { method: 'GET', path: '/api/sources', query: 'category=nature&q=coast' },
  'uploads-get': { method: 'GET', path: '/api/uploads' },
  'uploads-post': { method: 'POST', path: '/api/uploads', file: true },
  'upload-delete': { method: 'DELETE', path: '/api/uploads/filename' },
  'upload-get': { method: 'GET', path: '/uploads/filename' },
  'current-image': { method: 'GET', path: '/api/current-image' },
  'ai-generate': {
    method: 'POST',
    path: '/api/ai/generate',
    body: { provider: 'google', prompt: 'A quiet Danish coastline at dusk', orientation: 'portrait' },
  },
  generate: { method: 'POST', path: '/api/generate' },
  push: { method: 'POST', path: '/api/push' },
  'generate-and-push': {
    method: 'POST',
    path: '/api/generate-and-push',
    body: { text: 'A quiet Danish coastline at dusk', provider: 'google', orientation: 'portrait' },
  },
  'now-playing': { method: 'GET', path: '/api/now-playing' },
  assistant: {
    method: 'POST',
    path: '/api/assistant',
    body: { prompt: 'What is currently playing? Do not create an image.' },
  },
  'display-png': { method: 'GET', path: '/display.png' },
  'display-epdgz': { method: 'GET', path: '/display.epdgz' },
};

const apiEndpointSelect = document.querySelector('#api-endpoint');
const apiMethodSelect = document.querySelector('#api-method');
const apiPathInput = document.querySelector('#api-path');
const apiQueryInput = document.querySelector('#api-query');
const apiBodyInput = document.querySelector('#api-body');
const apiFileInput = document.querySelector('#api-file');
const apiSendButton = document.querySelector('#api-send');
const apiRequestStatus = document.querySelector('#api-request-status');
const apiResponseOutput = document.querySelector('#api-response-output');
const apiResponseLink = document.querySelector('#api-response-link');
let apiResponseObjectUrl;

function updateApiWorkbench() {
  const endpoint = apiEndpoints[apiEndpointSelect.value];
  apiMethodSelect.value = endpoint.method;
  apiPathInput.value = endpoint.path;
  apiQueryInput.value = endpoint.query || '';
  apiBodyInput.value = endpoint.body ? JSON.stringify(endpoint.body, null, 2) : '';
  const isUpload = Boolean(endpoint.file) && apiMethodSelect.value === 'POST';
  document.querySelector('#api-file-field').hidden = !isUpload;
  document.querySelector('#api-query-field').hidden = !['GET', 'HEAD'].includes(apiMethodSelect.value);
  document.querySelector('#api-body-field').hidden = isUpload || ['GET', 'HEAD', 'DELETE'].includes(apiMethodSelect.value);
}

async function sendApiWorkbenchRequest() {
  const method = apiMethodSelect.value;
  const path = apiPathInput.value.trim();
  if (!path.startsWith('/') || path.startsWith('//')) {
    apiRequestStatus.textContent = 'Path must be relative to this server.';
    return;
  }

  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin) {
    apiRequestStatus.textContent = 'Only same-origin requests are allowed.';
    return;
  }
  if (apiQueryInput.value.trim()) {
    const query = new URLSearchParams(apiQueryInput.value.trim());
    query.forEach((value, key) => url.searchParams.set(key, value));
  }

  const options = { method };
  const isUpload = apiEndpointSelect.value === 'uploads-post' && method === 'POST';
  if (isUpload) {
    if (!apiFileInput.files[0]) {
      apiRequestStatus.textContent = 'Choose an image file to upload.';
      return;
    }
    const formData = new FormData();
    formData.append('image', apiFileInput.files[0]);
    options.body = formData;
  } else if (!['GET', 'HEAD'].includes(method) && apiBodyInput.value.trim()) {
    try {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(JSON.parse(apiBodyInput.value));
    } catch {
      apiRequestStatus.textContent = 'Request body is not valid JSON.';
      return;
    }
  }

  apiSendButton.disabled = true;
  apiRequestStatus.textContent = 'Sending…';
  apiResponseOutput.textContent = '';
  apiResponseLink.hidden = true;
  if (apiResponseObjectUrl) {
    URL.revokeObjectURL(apiResponseObjectUrl);
    apiResponseObjectUrl = null;
  }

  const startedAt = performance.now();
  try {
    const response = await fetch(url, options);
    const elapsed = Math.round(performance.now() - startedAt);
    const contentType = response.headers.get('content-type') || '';
    if (response.status === 204 || method === 'HEAD') {
      apiResponseOutput.textContent = '(empty response)';
    } else if (contentType.startsWith('application/json')) {
      const text = await response.text();
      try {
        apiResponseOutput.textContent = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        apiResponseOutput.textContent = text;
      }
    } else if (contentType.startsWith('text/')) {
      apiResponseOutput.textContent = await response.text();
    } else {
      const blob = await response.blob();
      apiResponseObjectUrl = URL.createObjectURL(blob);
      apiResponseLink.href = apiResponseObjectUrl;
      apiResponseLink.download = url.pathname.split('/').pop() || 'response';
      apiResponseLink.textContent = `Open or download ${contentType || 'response'}`;
      apiResponseLink.hidden = false;
      apiResponseOutput.textContent = `Binary response · ${contentType || 'unknown type'} · ${blob.size.toLocaleString()} bytes`;
    }
    apiRequestStatus.textContent = `${response.status} ${response.statusText} · ${elapsed} ms`;
  } catch (error) {
    apiResponseOutput.textContent = error.message;
    apiRequestStatus.textContent = 'Request failed';
  } finally {
    apiSendButton.disabled = false;
  }
}

apiEndpointSelect.addEventListener('change', updateApiWorkbench);
apiMethodSelect.addEventListener('change', () => {
  const endpoint = apiEndpoints[apiEndpointSelect.value];
  const isUpload = Boolean(endpoint.file) && apiMethodSelect.value === 'POST';
  document.querySelector('#api-file-field').hidden = !isUpload;
  document.querySelector('#api-query-field').hidden = !['GET', 'HEAD'].includes(apiMethodSelect.value);
  document.querySelector('#api-body-field').hidden = isUpload || ['GET', 'HEAD', 'DELETE'].includes(apiMethodSelect.value);
});
apiSendButton.addEventListener('click', sendApiWorkbenchRequest);
updateApiWorkbench();

const apiLogList = document.querySelector('#api-log-list');
const apiLogsStatus = document.querySelector('#api-logs-status');
const apiLogsRefreshButton = document.querySelector('#refresh-api-logs');
const apiLogsOlderButton = document.querySelector('#load-older-api-logs');
let apiLogsCursor = null;
let apiLogRefreshTimer;

function logPayloadMarkup(label, payload) {
  const formatted = payload == null ? '(empty)' : JSON.stringify(payload, null, 2);
  return `<figure class="api-log-payload"><figcaption>${label}</figcaption><pre>${escapeHtml(formatted)}</pre></figure>`;
}

function apiLogMarkup(entry) {
  const query = new URLSearchParams(entry.query || {}).toString();
  const route = `${entry.path}${query ? `?${query}` : ''}`;
  const statusClass = entry.status >= 400 ? ' failed' : '';
  return `<details class="api-log-entry">
    <summary>
      <span class="api-log-meta">
        <span class="api-log-type">${escapeHtml(entry.type)}</span>
        <span>${escapeHtml(entry.method)}</span>
        <span class="api-log-route" title="${escapeHtml(route)}">${escapeHtml(route)}</span>
        <span class="api-log-status${statusClass}">${escapeHtml(entry.status)}</span>
        <span class="api-log-duration">${escapeHtml(Math.round(entry.durationMs))} ms</span>
        <time class="api-log-time" datetime="${escapeHtml(entry.timestamp)}">${escapeHtml(new Date(entry.timestamp).toLocaleString())}</time>
      </span>
    </summary>
    <div class="api-log-payloads">
      ${logPayloadMarkup('Input', entry.input)}
      ${logPayloadMarkup('Output', entry.output)}
    </div>
  </details>`;
}

async function loadApiLogs(reset = true) {
  if (apiLogsRefreshButton.disabled) return;
  apiLogsRefreshButton.disabled = true;
  apiLogsStatus.textContent = 'Loading saved calls…';
  try {
    const params = new URLSearchParams({ limit: '100' });
    if (!reset && apiLogsCursor) params.set('before_id', apiLogsCursor);
    const response = await fetch(`/api/logs?${params}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || 'Could not load API call logs.');
    if (reset) apiLogList.innerHTML = '';
    const items = result.items || [];
    if (items.length) {
      apiLogList.insertAdjacentHTML('beforeend', items.map(apiLogMarkup).join(''));
    }
    if (reset && !items.length) {
      apiLogList.innerHTML = '<div class="api-log-empty">No API or MCP calls have been saved yet.</div>';
    }
    apiLogsCursor = result.nextBeforeId;
    apiLogsOlderButton.hidden = !apiLogsCursor;
    apiLogsStatus.textContent = `${items.length ? apiLogList.querySelectorAll('.api-log-entry').length : 0} saved call(s) loaded · logs are kept indefinitely`;
  } catch (error) {
    apiLogsStatus.textContent = error.message;
  } finally {
    apiLogsRefreshButton.disabled = false;
  }
}

function scheduleApiLogRefresh() {
  clearTimeout(apiLogRefreshTimer);
  apiLogRefreshTimer = setTimeout(() => loadApiLogs(true), 250);
}

apiLogsRefreshButton.addEventListener('click', () => loadApiLogs(true));
apiLogsOlderButton.addEventListener('click', () => loadApiLogs(false));
loadApiLogs();

loadItems();
loadStatus();