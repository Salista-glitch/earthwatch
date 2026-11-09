/* Shared data rules. No globe or DOM code here, so we can test these separately. */
(function (root) {
  'use strict';
  const HOUR = 60 * 60 * 1000;

  function validPoint(longitude, latitude) {
    return Number.isFinite(longitude) && Number.isFinite(latitude)
      && longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90;
  }

  function safeLink(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' ? url.href : null;
    } catch { return null; }
  }

  function normalizeQuakes(payload, receivedAt) {
    if (!payload || !Array.isArray(payload.features)) throw new Error('USGS response has no features array.');
    const observations = [];
    for (const feature of payload.features) {
      const properties = feature.properties || {};
      const coordinates = feature.geometry?.coordinates || [];
      const [longitude, latitude, depth] = coordinates;
      if (!feature.id || !validPoint(longitude, latitude) || !Number.isFinite(properties.time)) continue;
      observations.push({
        id: 'usgs:' + feature.id,
        eventId: feature.id,
        source: 'USGS',
        kind: 'Earthquake',
        title: properties.place || 'Location not supplied',
        longitude, latitude,
        depth: Number.isFinite(depth) ? depth : null,
        magnitude: Number.isFinite(properties.mag) ? properties.mag : null,
        observedAt: properties.time,
        updatedAt: Number.isFinite(properties.updated) ? properties.updated : null,
        receivedAt,
        url: safeLink(properties.url),
        status: properties.status || 'Not supplied'
      });
    }
    return observations;
  }

  function normalizeEvents(payload, receivedAt) {
    if (!payload || !Array.isArray(payload.events)) throw new Error('EONET response has no events array.');
    const observations = [];
    for (const event of payload.events) {
      if (!event.id) continue;
      for (const [index, geometry] of (event.geometry || []).entries()) {
        // Do not pretend a polygon is a point, or silently swap coordinate order.
        if (geometry.type !== 'Point') continue;
        const [longitude, latitude] = geometry.coordinates || [];
        const observedAt = Date.parse(geometry.date);
        if (!validPoint(longitude, latitude) || !Number.isFinite(observedAt)) continue;
        observations.push({
          id: 'eonet:' + event.id + ':' + geometry.date + ':' + index,
          eventId: event.id,
          source: 'NASA EONET',
          kind: (event.categories || []).map(category => category.title).join(', ') || 'Natural event',
          title: event.title || 'Untitled natural event',
          longitude, latitude, observedAt, receivedAt,
          updatedAt: null,
          magnitude: Number.isFinite(geometry.magnitudeValue) ? geometry.magnitudeValue : null,
          magnitudeUnit: geometry.magnitudeUnit || '',
          url: safeLink(event.sources?.[0]?.url) || safeLink(event.link),
          status: event.closed ? 'Closed by source' : 'Open in EONET'
        });
      }
    }
    return observations;
  }

  function distanceKm(latitude1, longitude1, latitude2, longitude2) {
    const radians = degrees => degrees * Math.PI / 180;
    const deltaLatitude = radians(latitude2 - latitude1);
    const deltaLongitude = radians(longitude2 - longitude1);
    const a = Math.sin(deltaLatitude / 2) ** 2
      + Math.cos(radians(latitude1)) * Math.cos(radians(latitude2)) * Math.sin(deltaLongitude / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function filterObservations(observations, options) {
    const query = (options.query || '').trim().toLowerCase();
    return observations.filter(observation => {
      if (observation.observedAt < options.start || observation.observedAt > options.end) return false;
      if (observation.source === 'USGS' && !options.quakes) return false;
      if (observation.source === 'NASA EONET' && !options.events) return false;
      if (observation.source === 'NASA FIRMS' && !options.fires) return false;
      if (query && !(observation.title + ' ' + observation.kind + ' ' + observation.source).toLowerCase().includes(query)) return false;
      if (options.area) {
        const area = options.area;
        if (distanceKm(area.latitude, area.longitude, observation.latitude, observation.longitude) > area.radius) return false;
      }
      return true;
    }).sort((a, b) => b.observedAt - a.observedAt);
  }

  function ageLabel(observedAt, now = Date.now()) {
    const minutes = Math.floor((now - observedAt) / 60000);
    if (minutes < 0) return 'Future source timestamp';
    if (minutes < 1) return 'Less than a minute';
    if (minutes < 60) return minutes + ' min';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + ' h ' + (minutes % 60) + ' min';
    return Math.floor(hours / 24) + ' d ' + (hours % 24) + ' h';
  }

  function readSnapshot(payload) {
    if (payload?.schemaVersion !== 1 || !Number.isFinite(payload.generatedAt) || !Array.isArray(payload.observations) || !Array.isArray(payload.sources)) {
      throw new Error('Snapshot has an unsupported format. Run the Python pipeline again.');
    }
    const observations = new Map();
    for (const item of payload.observations) {
      if (typeof item.id !== 'string' || typeof item.title !== 'string' || typeof item.kind !== 'string'
        || !['USGS', 'NASA EONET', 'NASA FIRMS'].includes(item.source)
        || !validPoint(item.longitude, item.latitude) || !Number.isFinite(item.observedAt)
        || !Number.isFinite(item.receivedAt)) throw new Error('Snapshot contains an invalid observation.');
      observations.set(item.id, { ...item, url: safeLink(item.url) });
    }
    for (const source of payload.sources) {
      if (!['USGS', 'NASA EONET', 'NASA FIRMS'].includes(source.name) || typeof source.ok !== 'boolean'
        || (source.receivedAt !== null && !Number.isFinite(source.receivedAt))) throw new Error('Snapshot has invalid source status.');
    }
    if (new Set(payload.sources.map(source => source.name)).size !== 3 || payload.sources.length !== 3) throw new Error('Snapshot must report all three sources.');
    return { observations, sources: payload.sources, generatedAt: payload.generatedAt };
  }

  function readConfig(config) {
    if (typeof config?.snapshotUrl !== 'string') throw new Error('Invalid snapshot configuration.');
    if (config.snapshotUrl === '') return { url: 'data/observations.json', local: true };
    const url = new URL(config.snapshotUrl);
    if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/.test(url.hostname)
      || url.username || url.password || url.port || url.search || url.hash
      || url.pathname !== '/earthwatch/observations.json') {
      throw new Error('Configure the public EarthWatch Blob URL.');
    }
    return { url: url.href, local: false };
  }

  const api = { HOUR, validPoint, safeLink, normalizeQuakes, normalizeEvents, distanceKm, filterObservations, ageLabel, readSnapshot, readConfig };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.EarthWatchData = api;
})(typeof window !== 'undefined' ? window : globalThis);
