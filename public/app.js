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
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || result.detail || 'Something went wrong.');
  return result;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function cardMarkup(item) {
  const isSelected = selected?.id === item.id;
  return `<button class="source-card${isSelected ? ' selected' : ''}" data-id="${encodeURIComponent(item.id)}" data-category="${category}" aria-label="Select ${escapeHtml(item.title)}" aria-pressed="${isSelected}"><div class="source-image-wrap"><img src="${escapeHtml(item.image)}" alt="" loading="lazy"><span class="selected-check">✓</span></div><span class="source-caption">${escapeHtml(item.title)}</span><span class="source-subtitle">${escapeHtml(item.subtitle || '')}</span></button>`;
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
  const card = event.target.closest('.source-card');
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
loadItems();
loadStatus();