/* EarthWatch globe presentation and interaction.
 * Follow the data path: refreshData -> normalization in data.js -> render -> globe.
 * No secrets belong in this browser code.
 */
'use strict';
const $ = id => document.getElementById(id);
const Data = window.EarthWatchData;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const sources = [
  { name: 'USGS', url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson', normalize: Data.normalizeQuakes, description: 'M2.5+ observations · past 7 days' },
  { name: 'NASA EONET', description: 'Reported natural-event locations · global' },
  { name: 'NASA FIRMS', description: 'NOAA-20 VIIRS · southern Africa · past 24 hours' }
];
const defaultAreas = [
  { id: 'southern-africa', name: 'Southern Africa', latitude: -24, longitude: 26, radius: 2200 },
  { id: 'cape-region', name: 'Cape region', latitude: -33.92, longitude: 18.42, radius: 400 }
];
const state = {
  observations: new Map(),
  sourceStatus: new Map(),
  areas: [...defaultAreas],
  activeArea: 'southern-africa',
  scope: 'global',
  hours: 24,
  cutoff: 1000,
  anchor: Date.now(),
  selected: null,
  refreshing: false,
  playing: false,
  viewer: null,
  entities: new Map(),
  boundaries: [],
  lastRetrieval: null
};
const MAX_MARKERS = 1500;
let pulseTargets = [];
const markerImages = new Map();
let playbackTimer;
let toastTimer;

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000);
}

function dateTime(timestamp) {
  return new Date(timestamp).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC'
  }) + ' UTC';
}

function timeOnly(timestamp) {
  return new Date(timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
}

function coordinateLabel(latitude, longitude) {
  return Math.abs(latitude).toFixed(2) + '° ' + (latitude < 0 ? 'S' : 'N')
    + ' / ' + Math.abs(longitude).toFixed(2) + '° ' + (longitude < 0 ? 'W' : 'E');
}

function currentArea() { return state.areas.find(area => area.id === state.activeArea); }

function timelineBounds() {
  const start = state.anchor - state.hours * Data.HOUR;
  const end = start + state.hours * Data.HOUR * state.cutoff / 1000;
  return { start, end };
}

function visibleObservations() {
  return Data.filterObservations([...state.observations.values()], {
    ...timelineBounds(), query: $('search').value,
    quakes: $('layer-quakes').checked,
    events: $('layer-events').checked,
    fires: $('layer-fires').checked,
    area: state.scope === 'area' ? currentArea() : null
  });
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error('Source returned HTTP ' + response.status);
    return await response.json();
  } finally { clearTimeout(timeout); }
}

async function refreshData() {
  if (state.refreshing) return;
  state.refreshing = true;
  $('refresh').disabled = true;
  $('status-dot').className = 'status-dot loading';
  $('status-label').textContent = 'RETRIEVING';

  // The browser reads the pipeline's output, never the database or a secret.
  // Validate the entire snapshot BEFORE replacing the previous working state.
  try {
    const config = Data.readConfig(await fetchJson('config.json'));
    const snapshot = Data.readSnapshot(await fetchJson(config.url));
    state.localSnapshot = config.local;
    state.observations = snapshot.observations;
    state.sourceStatus = new Map(snapshot.sources.map(source => [source.name, source]));
    state.lastRetrieval = snapshot.generatedAt;
    state.snapshotError = null;
  } catch (error) {
    state.snapshotError = error.name === 'AbortError' ? 'Snapshot request timed out.' : error.message;
  }
  state.refreshing = false;
  if (state.cutoff === 1000) state.anchor = Date.now();
  $('refresh').disabled = false;
  updateSourceStatus();
  render();
}

function updateSourceStatus() {
  const fresh = status => status.ok && Number.isFinite(status.receivedAt) && Date.now() - status.receivedAt < 3 * Data.HOUR;
  const successful = [...state.sourceStatus.values()].filter(fresh).length;
  $('status-dot').className = 'status-dot ' + (state.snapshotError ? 'error' : successful === 3 ? '' : successful ? 'partial' : 'error');
  $('status-label').textContent = state.snapshotError ? 'SNAPSHOT UNAVAILABLE' : successful === 3 ? 'DATA CURRENT' : successful ? 'PARTIAL / DELAYED' : 'DATA DELAYED';
  $('source-status-list').replaceChildren();
  for (const source of sources) {
    const status = state.sourceStatus.get(source.name);
    const row = makeElement('div', 'source-status-row');
    row.append(makeElement('strong', '', source.name));
    row.append(makeElement('span', status && fresh(status) ? '' : 'failed', status && fresh(status) ? 'CURRENT' : status?.ok ? 'DELAYED' : 'FAILED'));
    row.append(makeElement('p', '', source.description));
    row.append(makeElement('p', '', status?.receivedAt ? 'Pipeline retrieval: ' + dateTime(status.receivedAt) + ' · ' + status.count + ' observations' : 'No successful pipeline retrieval.'));
    if (status?.message) row.append(makeElement('p', '', status.message + (status.receivedAt ? ' Showing last successful data.' : '')));
    $('source-status-list').append(row);
  }
  $('refresh-label').textContent = state.lastRetrieval ? (state.localSnapshot ? 'Local snapshot ' : 'Snapshot ') + Data.ageLabel(state.lastRetrieval) + ' old' : 'No snapshot loaded';
  $('snapshot-message').hidden = !state.snapshotError;
  $('snapshot-message').textContent = state.snapshotError ? state.snapshotError + (state.observations.size ? ' Last loaded snapshot retained.' : ' No observations available. Check source status.') : '';
}

function renderFeed(observations) {
  const feed = $('feed-list');
  feed.replaceChildren();
  $('feed-count').textContent = observations.length.toLocaleString();
  $('coverage-label').textContent = state.scope === 'global' ? 'GLOBAL COVERAGE' : currentArea().name.toUpperCase();
  $('feed-window').textContent = state.cutoff === 1000 ? 'LAST ' + state.hours + ' HOURS' : 'REPLAY';
  $('map-count').textContent = observations.length > MAX_MARKERS ? 'MAP: NEWEST ' + MAX_MARKERS.toLocaleString() + ' / ' + observations.length.toLocaleString() + ' MATCHES' : 'MAP: ' + observations.length.toLocaleString() + ' OBSERVATIONS';
  if (!observations.length) {
    const empty = makeElement('div', 'empty-state');
    const hasData = state.observations.size > 0;
    empty.append(makeElement('h3', '', hasData ? 'A quieter window' : state.refreshing ? 'Listening to the planet' : 'No observations received'));
    empty.append(makeElement('p', '', hasData ? 'No matching observations in this time window. Try a wider period, another layer, or global coverage.' : state.refreshing ? 'Reading the pipeline snapshot.' : 'The data snapshot is unavailable. Source status has more details.'));
    if (hasData && (state.scope === 'area' || state.hours < 168 || state.cutoff < 1000 || $('search').value)) {
      const button = makeElement('button', '', 'Explore global · 7 days ↗');
      button.addEventListener('click', () => {
        state.hours = 168; $('window-select').value = '168'; $('search').value = '';
        setScope('global'); goNow();
      });
      empty.append(button);
    }
    feed.append(empty);
    return;
  }
  // Keep the feed bounded; all matching markers are still plotted on the globe.
  for (const observation of observations.slice(0, 100)) {
    const button = makeElement('button', 'observation' + (state.selected?.id === observation.id ? ' selected' : ''));
    const top = makeElement('div', 'observation-top');
    const isQuake = observation.source === 'USGS';
    top.append(makeElement('span', 'event-kind' + (isQuake ? ' quake' : ''), observation.kind));
    const time = makeElement('time', '', dateTime(observation.observedAt));
    time.dateTime = new Date(observation.observedAt).toISOString();
    top.append(time);
    button.append(top, makeElement('h3', '', observation.title));
    const bottom = makeElement('div', 'observation-bottom');
    bottom.append(makeElement('span', '', observation.source));
    bottom.append(makeElement('span', isQuake ? 'magnitude' : 'event-arrow', isQuake ? 'M ' + (observation.magnitude ?? '—') : '↗'));
    button.append(bottom);
    button.addEventListener('click', () => selectObservation(observation));
    feed.append(button);
  }
  if (observations.length > 100) feed.append(makeElement('p', 'help', 'Newest 100 observations listed. Use search, time and area filters to investigate.'));
}

function renderTimeline() {
  const { start, end } = timelineBounds();
  $('timeline-start').textContent = new Date(start).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' }).toUpperCase() + ' / UTC';
  $('timeline-current').textContent = state.cutoff === 1000 ? 'NOW' : dateTime(end);
  $('tick-start').textContent = timeOnly(start);
  $('tick-mid').textContent = timeOnly(start + state.hours * Data.HOUR / 2);
  $('tick-end').textContent = timeOnly(state.anchor);
  $('timeline-slider').value = state.cutoff;
  $('go-now').classList.toggle('active', state.cutoff === 1000);
}

function markerImage(color) {
  if (markerImages.has(color)) return markerImages.get(color);
  // An explicit RGBA image avoids inconsistent canvas texture uploads on some
  // WebGL drivers. This is a screen-space symbol, never an affected-area polygon.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">'
    + '<defs><radialGradient id="glow"><stop offset="0" stop-color="' + color + '" stop-opacity=".95"/>'
    + '<stop offset=".3" stop-color="' + color + '" stop-opacity=".7"/>'
    + '<stop offset="1" stop-color="' + color + '" stop-opacity="0"/></radialGradient></defs>'
    + '<circle cx="32" cy="32" r="31" fill="url(#glow)"/>'
    + '<circle cx="32" cy="32" r="7" fill="' + color + '"/>'
    + '<circle cx="32" cy="32" r="3" fill="#fff6de"/></svg>';
  const image = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  markerImages.set(color, image);
  return image;
}

function renderGlobe(observations) {
  if (!state.viewer || !state.markerLayer) return;
  const Cesium = window.Cesium;
  const collection = state.markerLayer.entities;
  collection.suspendEvents();
  const plotted = observations.slice(0, MAX_MARKERS);
  if (state.selected && observations.some(item => item.id === state.selected.id) && !plotted.some(item => item.id === state.selected.id)) plotted.push(state.selected);
  const visibleIds = new Set(plotted.map(observation => observation.id));
  for (const [id, entity] of state.entities) {
    if (!visibleIds.has(id)) {
      collection.remove(entity);
      state.entities.delete(id);
    }
  }
  for (const observation of plotted) {
    if (state.entities.has(observation.id)) {
      const entity = state.entities.get(observation.id);
      entity.observation = observation;
      entity.position = Cesium.Cartesian3.fromDegrees(observation.longitude, observation.latitude, 8000);
      continue;
    }
    const isQuake = observation.source === 'USGS';
    const color = isQuake ? '#86cfff' : observation.source === 'NASA FIRMS' ? '#ff9759' : '#ffd591';
    const entity = collection.add({
      id: observation.id,
      position: Cesium.Cartesian3.fromDegrees(observation.longitude, observation.latitude, 8000),
      billboard: {
        image: markerImage(color), width: isQuake ? 40 : 34, height: isQuake ? 40 : 34,
        scaleByDistance: new Cesium.NearFarScalar(100000, 1.6, 30000000, .65)
      }
    });
    entity.observation = observation;
    state.entities.set(observation.id, entity);
  }
  pulseTargets = plotted.slice(0, 6).map(item => state.entities.get(item.id));
  if (state.selected && state.entities.has(state.selected.id)) pulseTargets.push(state.entities.get(state.selected.id));
  for (const entity of state.entities.values()) entity.billboard.scale = 1;
  collection.resumeEvents();
  state.viewer.scene.requestRender();
}

function render() {
  const observations = visibleObservations();
  renderFeed(observations);
  renderTimeline();
  renderGlobe(observations);
  if (state.selected && !observations.some(observation => observation.id === state.selected.id)) {
    $('detail').hidden = true;
    state.selected = null;
  }
}

function selectObservation(observation) {
  state.selected = observation;
  $('detail').hidden = false;
  $('detail-type').textContent = observation.source + ' / ' + observation.kind.toUpperCase();
  $('detail-title').textContent = observation.title;
  $('detail-metrics').replaceChildren();
  const metrics = observation.source === 'NASA FIRMS'
    ? [[observation.frp === null ? '—' : observation.frp.toFixed(1), 'FRP / MW'], [observation.confidence || '—', 'CONFIDENCE']]
    : observation.source === 'USGS'
    ? [[observation.magnitude === null ? '—' : observation.magnitude.toFixed(1), 'MAGNITUDE'], [observation.depth === null ? '—' : observation.depth.toFixed(0) + ' km', 'DEPTH']]
    : [['⌖', 'REPORTED LOCATION']];
  for (const [value, label] of metrics) {
    const metric = makeElement('div', 'metric');
    metric.append(makeElement('strong', '', value), makeElement('small', '', label));
    $('detail-metrics').append(metric);
  }
  const fields = [
    ['Observation time', dateTime(observation.observedAt)],
    ['Observation age', Data.ageLabel(observation.observedAt)],
    ['Retrieved by pipeline', dateTime(observation.receivedAt)],
    ['Observation to retrieval', Data.ageLabel(observation.observedAt, observation.receivedAt) + ' · not publication delay'],
    ['Coordinates', coordinateLabel(observation.latitude, observation.longitude)],
    ['Source record', observation.eventId],
    ['Source status', observation.status]
  ];
  if (observation.source === 'NASA FIRMS') fields.push(['Sensor', observation.satellite + ' / ' + observation.instrument], ['Meaning', 'A detected thermal anomaly. Glow and pulse are visual markers, not affected area or severity.']);
  if (observation.updatedAt) fields.splice(1, 0, ['Updated by source', dateTime(observation.updatedAt)]);
  $('detail-fields').replaceChildren();
  for (const [name, value] of fields) $('detail-fields').append(makeElement('dt', '', name), makeElement('dd', '', value));
  $('detail-link').hidden = !observation.url;
  if (observation.url) $('detail-link').href = observation.url;
  if (state.viewer) {
    state.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(observation.longitude, observation.latitude - 1, 2500000),
      duration: reducedMotion ? 0 : 1.8
    });
  }
  $('view-label').textContent = coordinateLabel(observation.latitude, observation.longitude);
  renderFeed(visibleObservations());
  renderGlobe(visibleObservations());
}

function drawBoundaries() {
  if (!state.viewer) return;
  for (const entity of state.boundaries) state.viewer.entities.remove(entity);
  state.boundaries = [];
  if (!$('layer-boundaries').checked) return;
  const area = currentArea();
  const positions = [];
  const angularDistance = area.radius / 6371;
  const latitude = Cesium.Math.toRadians(area.latitude);
  const longitude = Cesium.Math.toRadians(area.longitude);
  for (let degrees = 0; degrees <= 360; degrees += 3) {
    const bearing = Cesium.Math.toRadians(degrees);
    const lat = Math.asin(Math.sin(latitude) * Math.cos(angularDistance) + Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing));
    const lon = longitude + Math.atan2(Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude), Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(lat));
    positions.push(Cesium.Cartesian3.fromRadians(lon, lat, 12000));
  }
  state.boundaries.push(state.viewer.entities.add({
    polyline: { positions, width: 1.2, material: Cesium.Color.fromCssColorString('#8ec9e6').withAlpha(.5) }
  }));
  state.viewer.scene.requestRender();
}

function flyToArea(area, orbital = false) {
  if (!state.viewer) return;
  state.viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(area.longitude, area.latitude, orbital ? 18000000 : Math.max(1500000, area.radius * 4000)),
    duration: reducedMotion ? 0 : 1.8
  });
  $('view-label').textContent = area.name + (orbital ? ' · orbital view' : ' · watch area');
}

function setScope(scope) {
  state.scope = scope;
  $('scope-global').classList.toggle('active', scope === 'global');
  $('scope-area').classList.toggle('active', scope === 'area');
  render();
}

function renderWatches() {
  $('watch-list').replaceChildren();
  for (const area of state.areas) {
    const row = makeElement('div', 'watch-row' + (area.id === state.activeArea ? ' active' : ''));
    const button = makeElement('button', 'watch-select');
    button.append(makeElement('span', 'watch-dot'), makeElement('span', '', area.name));
    button.addEventListener('click', () => {
      state.activeArea = area.id;
      renderWatches(); drawBoundaries(); flyToArea(area); setScope('area');
    });
    row.append(button);
    if (!defaultAreas.some(original => original.id === area.id)) {
      const remove = makeElement('button', 'watch-delete', '×');
      remove.setAttribute('aria-label', 'Remove ' + area.name);
      remove.addEventListener('click', () => {
        state.areas = state.areas.filter(item => item.id !== area.id);
        if (state.activeArea === area.id) state.activeArea = defaultAreas[0].id;
        saveWatches(); renderWatches(); drawBoundaries(); render();
      });
      row.append(remove);
    }
    $('watch-list').append(row);
  }
}

function saveWatches() {
  try { localStorage.setItem('earthwatch.areas.v1', JSON.stringify(state.areas.filter(area => !defaultAreas.some(original => original.id === area.id)))); }
  catch { toast('Browser storage is unavailable. This watch area will last for this session.'); }
}

function loadWatches() {
  try {
    const saved = JSON.parse(localStorage.getItem('earthwatch.areas.v1') || '[]');
    if (Array.isArray(saved)) {
      for (const area of saved.slice(0, 20)) {
        if (typeof area.id === 'string' && typeof area.name === 'string' && area.name.length <= 45 && Data.validPoint(area.longitude, area.latitude) && Number.isFinite(area.radius) && area.radius >= 10 && area.radius <= 3000 && !state.areas.some(item => item.id === area.id)) state.areas.push(area);
      }
    }
  } catch { /* A malformed local setting should not stop the observatory. */ }
}

function stopPlayback() {
  state.playing = false;
  clearInterval(playbackTimer);
  $('play').textContent = '▶';
  $('play').setAttribute('aria-label', 'Play observation timeline');
}

function goNow() {
  stopPlayback(); state.cutoff = 1000; state.anchor = Date.now(); render();
}

async function initializeGlobe() {
  try {
    if (!window.Cesium) throw new Error('Cesium failed to load.');
    // Supply our own public imagery provider: no Cesium ion account/token needed.
    Cesium.Ion.defaultAccessToken = undefined;
    const imagery = new Cesium.UrlTemplateImageryProvider({
      url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      maximumLevel: 18,
      credit: 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community'
    });
    const viewer = new Cesium.Viewer('globe', {
      baseLayer: new Cesium.ImageryLayer(imagery),
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      animation: false, timeline: false, baseLayerPicker: false,
      geocoder: false, homeButton: false, sceneModePicker: false,
      navigationHelpButton: false, fullscreenButton: false,
      infoBox: false, selectionIndicator: false,
      requestRenderMode: true, maximumRenderTimeChange: Infinity,
      contextOptions: { webgl: { alpha: false, antialias: true } }
    });
    state.viewer = viewer;
    // Screen-space clustering keeps dense satellite pixels readable from orbit.
    // A cluster count is a count of plotted observations, not a count of fires.
    state.markerLayer = new Cesium.CustomDataSource('EarthWatch observations');
    viewer.dataSources.add(state.markerLayer);
    state.markerLayer.clustering.enabled = true;
    state.markerLayer.clustering.pixelRange = 16;
    state.markerLayer.clustering.minimumClusterSize = 4;
    state.markerLayer.clustering.clusterEvent.addEventListener((entities, cluster) => {
      const color = entities.every(entity => entity.observation?.source === 'USGS') ? '#86cfff' : '#ff9759';
      cluster.point.show = false;
      cluster.billboard.show = true;
      cluster.billboard.image = markerImage(color);
      cluster.billboard.width = 54;
      cluster.billboard.height = 54;
      cluster.billboard.id = entities;
      cluster.label.show = true;
      cluster.label.text = entities.length.toLocaleString();
      cluster.label.font = 'bold 12px monospace';
      cluster.label.fillColor = Cesium.Color.WHITE;
      cluster.label.outlineColor = Cesium.Color.fromCssColorString('#132331');
      cluster.label.outlineWidth = 3;
      cluster.label.style = Cesium.LabelStyle.FILL_AND_OUTLINE;
      cluster.label.horizontalOrigin = Cesium.HorizontalOrigin.CENTER;
      cluster.label.verticalOrigin = Cesium.VerticalOrigin.CENTER;
      cluster.label.id = entities;
    });
    viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#03070c');
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#163c56');
    // Fixed scenic lighting is deliberately independent of observation replay.
    // This is not a claim that the basemap is a live photograph.
    viewer.clock.currentTime = Cesium.JulianDate.fromIso8601('2026-10-27T10:00:00Z');
    viewer.clock.shouldAnimate = false;
    viewer.scene.globe.enableLighting = true;
    viewer.scene.globe.showGroundAtmosphere = false;
    viewer.scene.skyBox.show = false;
    viewer.imageryLayers.get(0).brightness = .85;
    viewer.imageryLayers.get(0).contrast = 1.25;
    viewer.imageryLayers.get(0).saturation = 1.1;
    viewer.scene.globe.maximumScreenSpaceError = 1.5;
    viewer.scene.fog.enabled = true;
    if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = true;
    viewer.scene.postProcessStages.fxaa.enabled = true;
    viewer.scene.screenSpaceCameraController.minimumZoomDistance = 10000;
    viewer.scene.screenSpaceCameraController.maximumZoomDistance = 45000000;
    viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(26, -24, reducedMotion ? 18000000 : 26000000) });
    if (!reducedMotion) setTimeout(() => flyToArea(defaultAreas[0], true), 400);
    viewer.screenSpaceEventHandler.setInputAction(click => {
      const picked = viewer.scene.pick(click.position);
      if (picked?.id?.observation) selectObservation(picked.id.observation);
      else if (Array.isArray(picked?.id)) {
        const positions = picked.id.map(entity => entity.position.getValue(viewer.clock.currentTime));
        const sphere = Cesium.BoundingSphere.fromPoints(positions);
        viewer.camera.flyToBoundingSphere(sphere, {
          duration: reducedMotion ? 0 : 1.4,
          offset: new Cesium.HeadingPitchRange(0, -Math.PI / 2, Math.max(150000, sphere.radius * 4))
        });
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    let tileFailureNotified = false;
    imagery.errorEvent.addEventListener(() => {
      if (!tileFailureNotified) toast('Satellite basemap tiles are unavailable. Observation positions remain usable.');
      tileFailureNotified = true;
    });
    viewer.camera.moveEnd.addEventListener(() => {
      const position = viewer.camera.positionCartographic;
      $('coordinates').textContent = coordinateLabel(Cesium.Math.toDegrees(position.latitude), Cesium.Math.toDegrees(position.longitude));
    });
    $('globe-loading').hidden = true;
    drawBoundaries(); render();
  } catch (error) {
    $('globe-loading').hidden = true;
    $('globe-error').hidden = false;
    console.error('Globe startup:', error);
  }
}

function bindControls() {
  $('layer-quakes').addEventListener('change', render);
  $('layer-events').addEventListener('change', render);
  $('layer-fires').addEventListener('change', render);
  $('layer-boundaries').addEventListener('change', drawBoundaries);
  $('search').addEventListener('input', render);
  $('scope-global').addEventListener('click', () => setScope('global'));
  $('scope-area').addEventListener('click', () => setScope('area'));
  $('refresh').addEventListener('click', refreshData);
  $('status-button').addEventListener('click', () => { updateSourceStatus(); $('status-dialog').showModal(); });
  $('about-button').addEventListener('click', () => $('about-dialog').showModal());
  $('close-detail').addEventListener('click', () => { $('detail').hidden = true; state.selected = null; render(); });
  $('window-select').addEventListener('change', event => { state.hours = Number(event.target.value); goNow(); });
  $('timeline-slider').addEventListener('input', event => { stopPlayback(); state.cutoff = Number(event.target.value); render(); });
  $('go-now').addEventListener('click', goNow);
  $('play').addEventListener('click', () => {
    if (state.playing) { stopPlayback(); return; }
    state.playing = true;
    if (state.cutoff === 1000) state.cutoff = 0;
    $('play').textContent = 'Ⅱ';
    $('play').setAttribute('aria-label', 'Pause observation timeline');
    playbackTimer = setInterval(() => {
      state.cutoff = Math.min(1000, state.cutoff + 8);
      render();
      if (state.cutoff === 1000) stopPlayback();
    }, 160);
  });
  const reset = () => { state.activeArea = 'southern-africa'; renderWatches(); drawBoundaries(); flyToArea(defaultAreas[0], true); render(); };
  $('reset-view').addEventListener('click', reset);
  $('region-button').addEventListener('click', reset);
  $('zoom-in').addEventListener('click', () => { if (state.viewer) state.viewer.camera.zoomIn(state.viewer.camera.positionCartographic.height * .35); });
  $('zoom-out').addEventListener('click', () => { if (state.viewer) state.viewer.camera.zoomOut(state.viewer.camera.positionCartographic.height * .4); });
  $('fullscreen').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      else toast('Fullscreen is not supported by this browser.');
    } catch { toast('Fullscreen is unavailable in this preview.'); }
  });
  $('add-watch').addEventListener('click', () => $('watch-dialog').showModal());
  $('cancel-watch').addEventListener('click', () => $('watch-dialog').close());
  $('watch-form').addEventListener('submit', event => {
    event.preventDefault();
    const name = $('watch-name').value.trim();
    if (!name) { $('watch-name').setCustomValidity('Enter a watch area name.'); $('watch-name').reportValidity(); return; }
    if (state.areas.length >= 22) { toast('You can save up to 20 custom watch areas.'); return; }
    const area = {
      id: 'watch-' + crypto.randomUUID(), name,
      latitude: Number($('watch-lat').value), longitude: Number($('watch-lon').value), radius: Number($('watch-radius').value)
    };
    if (!Data.validPoint(area.longitude, area.latitude) || area.radius < 10 || area.radius > 3000) return;
    state.areas.push(area); state.activeArea = area.id;
    saveWatches(); renderWatches(); drawBoundaries(); flyToArea(area); setScope('area');
    $('watch-dialog').close(); toast('Watch area saved in this browser.');
  });
  $('watch-name').addEventListener('input', () => $('watch-name').setCustomValidity(''));
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('click', event => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); } });
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopPlayback(); });
}

function updateClock() {
  $('utc-clock').textContent = new Date().toLocaleTimeString('en-GB', { timeZone: 'UTC' }) + ' UTC';
}

loadWatches(); renderWatches(); bindControls(); renderTimeline(); updateClock();
initializeGlobe(); refreshData();
setInterval(updateClock, 1000);
// Only a few markers pulse; thousands of per-frame callbacks would waste GPU/CPU.
// The pulse is decorative, not an indication of source confidence or danger.
if (!reducedMotion) setInterval(() => {
  if (document.hidden || !state.viewer || !pulseTargets.length) return;
  const phase = performance.now() / 650;
  [...new Set(pulseTargets)].forEach((entity, index) => { entity.billboard.scale = 1.05 + .25 * Math.sin(phase + index); });
  state.viewer.scene.requestRender();
}, 50);
setInterval(() => {
  if (!state.refreshing) updateSourceStatus();
  if (state.selected) {
    const fields = $('detail-fields');
    const labels = [...fields.querySelectorAll('dt')];
    const age = labels.find(label => label.textContent === 'Observation age');
    if (age) age.nextElementSibling.textContent = Data.ageLabel(state.selected.observedAt);
  }
}, 60000);
setInterval(() => { if (!document.hidden) refreshData(); }, 5 * 60 * 1000);
