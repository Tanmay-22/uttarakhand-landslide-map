/* Uttarakhand landslide priority map (S50). Static page: reads data/index.json, then one
   data/runs/<run>/summary.json per chosen date and its lookup.json on the first map click. */
(function () {
  'use strict';

  var LAYERS = [
    {key: 'prio', name: 'Priority (hazard x impact)', perDay: true},
    {key: 'alert', name: 'Hazard alert', perDay: true},
    {key: 'prob', name: 'Probability', perDay: true},
    {key: 'susc', name: 'Susceptibility (terrain)'},
    {key: 'impact', name: 'Impact'},
    {key: 'lifeline', name: 'Lifeline roads'},
    {key: 'longterm', name: 'Long-term risk'}
  ];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
                     'October', 'November', 'December'];
  var S = {idx: null, byDate: {}, dates: [], run: null, summaries: {}, lookups: {}, day: 1, layer: 'prio',
           overlay: null, overlayUrl: null, calMonth: null, distLayers: {}, placeMarker: null, selPlace: null};
  var map, N;

  // ------------------------------------------------------------------ helpers
  function $(id) { return document.getElementById(id); }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function pd(s) { var p = s.split('-'); return {y: +p[0], m: +p[1] - 1, d: +p[2]}; }
  function nice(s, year) { var d = pd(s); return d.d + ' ' + MONTHS[d.m] + (year === false ? '' : ' ' + d.y); }
  function iso(y, m, d) { return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0'); }
  function pct(x) { if (!x) return '0 %'; var v = 100 * x; return (v < 0.1 ? '<0.1' : v < 10 ? v.toFixed(1) : v.toFixed(0)) + ' %'; }
  function num(x) { return Math.round(x).toLocaleString('en-US'); }
  function fmtP(p) { return p > 0 ? p.toExponential(1) : '0'; }
  function getJSON(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error(url + ': ' + r.status); return r.json(); });
  }
  function alertChip(a) {
    if (typeof a === 'string') a = N.alert.indexOf(a);
    if (a < 0 || a > 3) return '-';
    return '<span class="chip" style="background:' + N.alert_colors[a] + (a === 3 ? ';color:#fff' : '') + '">' + N.alert[a] + '</span>';
  }
  function prioChip(p) {
    if (!(p > 0 && p < 4)) return '<span class="chip" style="color:#777">none</span>';
    return '<span class="chip" style="background:' + N.prio_colors[p] + ';color:' + (p < 3 ? '#fff' : '#000') + '">' + N.prio[p] + '</span>';
  }
  function runDay() { return S.run.days[S.day - 1]; }

  // ------------------------------------------------------------------ state in the URL
  function readHash() {
    var o = {};
    location.hash.replace(/^#/, '').split('&').forEach(function (kv) {
      var p = kv.split('='); if (p[0]) o[p[0]] = decodeURIComponent(p[1] || '');
    });
    return o;
  }
  function writeHash() {
    if (!S.run) return;
    var h = '#date=' + S.run.issue_date + '&rain=' + (S.run.hindcast ? 'observed' : 'forecast') + '&day=' + S.day + '&layer=' + S.layer +
            '&base=' + S.base + '&op=' + Math.round(S.opacity * 100);
    history.replaceState(null, '', h);
  }

  // ------------------------------------------------------------------ start
  fetch('data/index.json', {cache: 'no-cache'}).then(function (r) { if (!r.ok) throw new Error('data/index.json: ' + r.status); return r.json(); }).then(init).catch(function (e) {
    $('runHead').innerHTML = '<p class="note">Could not load the site data (' + esc(e.message) + '). ' +
      'If you opened this file directly from disk, serve the folder with a web server instead.</p>';
  });

  function init(idx) {
    S.idx = idx; N = idx.names;
    document.title = idx.title; $('title').textContent = idx.title;
    $('official').innerHTML = idx.official_links.map(function (l) {
      return '<a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.name) + '</a>'; }).join(' and ');
    indexRuns(idx);
    S.od = idx.ondemand && idx.ondemand.worker_url ? idx.ondemand : null;

    map = L.map('map', {zoomSnap: 1, preferCanvas: true, attributionControl: true});
    // place names over satellite imagery sit above the output layer and take no clicks
    map.createPane('labels').style.zIndex = 450;
    map.getPane('labels').style.pointerEvents = 'none';
    S.bases = {};
    (idx.basemaps || [{key: 'b0', name: 'Base map', url: idx.basemap.url, attribution: idx.basemap.attribution}]).forEach(function (b) {
      var opt = {attribution: b.attribution, maxNativeZoom: b.max_zoom || 18, maxZoom: 18};
      var lay = L.tileLayer(b.url, opt);
      if (b.labels) lay = L.layerGroup([lay, L.tileLayer(b.labels, {maxNativeZoom: b.max_zoom || 18, maxZoom: 18, pane: 'labels'})]);
      S.bases[b.key] = lay;
      var o = document.createElement('option'); o.value = b.key; o.textContent = b.name; $('baseSel').appendChild(o);
    });
    var h0 = readHash();
    S.opacity = h0.op >= 0 && h0.op <= 100 && h0.op !== '' ? h0.op / 100 : (idx.overlay_opacity != null ? idx.overlay_opacity : 1);
    $('opacity').value = Math.round(S.opacity * 100);
    $('opacity').addEventListener('input', function () {
      S.opacity = this.value / 100; if (S.overlay) S.overlay.setOpacity(S.opacity); writeHash();
    });
    setBase(S.bases[h0.base] ? h0.base : $('baseSel').value);
    $('baseSel').addEventListener('change', function () { setBase(this.value); writeHash(); });
    S.bounds = L.latLngBounds(idx.static.bounds);
    map.fitBounds(S.bounds);
    // the page may open in a hidden or zero-size frame: fit again once the map has a size
    map.on('resize', function () { if (map.getZoom() < 6) map.fitBounds(S.bounds); });
    L.control.scale({imperial: false}).addTo(map);
    addLegend();
    getJSON('data/static/' + idx.static.districts).then(addDistricts);
    map.on('click', onMapClick);

    var sel = $('layerSel');
    LAYERS.forEach(function (l) {
      if (l.key !== 'prio' && l.key !== 'alert' && l.key !== 'prob' && !idx.static.layers[l.key]) return;
      var o = document.createElement('option'); o.value = l.key; o.textContent = l.name; sel.appendChild(o);
    });
    sel.addEventListener('change', function () { S.layer = sel.value; showOverlay(); writeHash(); });
    $('hideNone').checked = idx.hide_no_priority;
    $('hideNone').addEventListener('change', renderPlaces);
    $('distSel').addEventListener('change', renderPlaces);
    $('dateBtn').addEventListener('click', toggleCal);
    $('prevBtn').addEventListener('click', function () { stepDate(-1); });
    $('nextBtn').addEventListener('click', function () { stepDate(1); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeCal(); });
    document.addEventListener('click', function (e) {
      // composedPath is fixed when the click starts, so a button the calendar re-renders away still counts as inside
      var path = e.composedPath ? e.composedPath() : [e.target];
      if (!$('cal').hidden && path.indexOf($('cal')) < 0 && path.indexOf($('dateBtn')) < 0) closeCal();
    });
    renderFooter();

    if (!S.dates.length) { $('runHead').innerHTML = '<p class="note">No dates have been built yet.</p>'; return; }
    var h = readHash();
    if (h.layer && LAYERS.some(function (l) { return l.key === h.layer; })) S.layer = h.layer;
    sel.value = S.layer;
    if (h.day >= 1 && h.day <= 3) S.day = +h.day;
    var date = S.byDate[h.date] ? h.date : latestDate();
    var pending = loadPending();
    openDate(date, h.rain).then(function () {
      if (pending) waitFor(pending);
      else if (h.date && !S.byDate[h.date] && aheadDay(h.date)) openAhead(h.date);
      else if (h.date && !S.byDate[h.date] && canRequest(h.date)) showRequest(h.date);
    });
  }

  function indexRuns(idx) {
    S.byDate = {};
    idx.runs.forEach(function (r) {
      var e = S.byDate[r.date] || (S.byDate[r.date] = {});
      e[r.hindcast ? 'observed' : 'forecast'] = r;
    });
    S.dates = Object.keys(S.byDate).sort();
  }

  // ------------------------------------------------------------------ predictions on request (S58)
  // A date without a prediction, or with an out-of-date one, can be asked for: the Worker starts a run
  // in GitHub Actions, and the page checks the date list every 30 seconds until the date appears.
  function todayUTC() { return new Date().toISOString().slice(0, 10); }
  function addDays(s, n) { return new Date(Date.parse(s + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10); }
  function canRequest(s) { return !!S.od && s >= S.od.earliest && s <= addDays(todayUTC(), S.od.days_ahead); }
  // the next 3 dates are days 1 to 3 of today's forecast (day 1 = the day after the issue date): the day, or 0
  function aheadDay(s) {
    var today = todayUTC(), t = (S.byDate[today] || {}).forecast;
    if (!t || s <= today || s > addDays(today, 3)) return 0;
    return Math.round((Date.parse(s) - Date.parse(today)) / 864e5);
  }
  function openAhead(s) { S.day = aheadDay(s); return openDate(todayUTC(), 'forecast'); }
  function madeMs(r) { return r && r.made ? Date.parse(r.made) : NaN; }

  // What a click on an existing date could still improve: today's forecast after the weather models
  // have updated, or a forecast-style date once observed rain is likely in. null if nothing.
  function improvement(date) {
    if (!S.od) return null;
    var today = todayUTC(), e = S.byDate[date] || {};
    if (date >= today) {
      var t = (S.byDate[today] || {}).forecast;
      if (date > addDays(today, S.od.days_ahead)) return null;
      if (!t || !(Date.now() - madeMs(t) < S.od.forecast_max_age_h * 36e5)) {
        return {label: t ? 'Update today’s forecast' : 'Make today’s forecast',
                text: t ? 'The weather models have updated since this forecast was made.' : 'There is no forecast for today yet.'};
      }
      return null;
    }
    if (e.forecast && !e.observed && date <= addDays(today, -S.od.observed_after_days)) {
      return {label: 'Make the observed-rain version',
              text: 'Satellite rain for these days should now be in, so a hindcast with observed rain can be made.'};
    }
    return null;
  }

  function reqCard(inner) { $('runHead').innerHTML = '<div class="reqcard">' + inner + '</div>'; }
  function backLink() {
    return S.run ? '<button type="button" class="link" id="reqBack">Back to ' + nice(S.run.issue_date) + '</button>' : '';
  }
  function wireBack() { var b = $('reqBack'); if (b) b.addEventListener('click', renderHead); }

  function showRequest(date) {
    var ahead = date > todayUTC();
    reqCard('<h2>' + nice(date) + '</h2>' +
      '<p>' + (ahead ? 'This date is covered by today’s forecast (day ' + Math.round((Date.parse(date) - Date.parse(todayUTC())) / 864e5) +
                       '), which has not been made yet.'
                     : 'There is no prediction for this date yet.') + '</p>' +
      '<button type="button" class="primary" id="reqBtn">' + (ahead ? 'Make today’s forecast' : 'Make a prediction for this date') + '</button>' +
      '<p class="note">Predictions are made on request and take about 10 minutes. You can keep using the map meanwhile.</p>' +
      backLink());
    $('reqBtn').addEventListener('click', function () { ask(date); });
    wireBack();
  }

  function ask(date) {
    reqCard('<h2>' + nice(date) + '</h2><p class="busy">Sending the request…</p>');
    fetch(S.od.worker_url.replace(/\/$/, '') + '/request', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({date: date})
    }).then(function (r) { return r.json().catch(function () { return {status: 'error'}; }); }).then(function (res) {
      var st = res.status;
      if (st === 'started' || st === 'running' || st === 'recently_done') {
        var cur = (S.byDate[res.issue] || {})[res.run && res.run.slice(-6) === '_imerg' ? 'observed' : 'forecast'];
        waitFor({asked: date, issue: res.issue, run: res.run, since: Date.now(), prev: cur ? cur.made || '' : ''});
      } else if (st === 'up_to_date') {
        refreshIndex().then(function () { if (S.byDate[res.issue]) openDate(res.issue, res.run && /_imerg$/.test(res.run) ? 'observed' : 'forecast'); });
      } else if (st === 'limit') {
        failCard(date, 'Today’s limit of predictions has been reached. Please try again tomorrow.', false);
      } else if (st === 'not_possible') {
        failCard(date, 'No prediction is possible for this date' + (res.reason ? ' (' + esc(res.reason) + ')' : '') + '.', false);
      } else {
        failCard(date, 'The prediction service could not start this date' + (res.reason ? ' (' + esc(res.reason) + ')' : '') + '.', true);
      }
    }).catch(function () { failCard(date, 'The prediction service could not be reached. Please check your connection.', true); });
  }

  function failCard(date, msg, retry) {
    savePending(null);
    reqCard('<h2>' + nice(date) + '</h2><p class="err">' + msg + '</p>' +
      (retry ? '<button type="button" id="reqBtn">Try again</button> ' : '') + backLink());
    if (retry) $('reqBtn').addEventListener('click', function () { ask(date); });
    wireBack();
  }

  function waitFor(p) {
    savePending(p);
    if (S.waitTimer) clearTimeout(S.waitTimer);
    var mins = Math.floor((Date.now() - p.since) / 6e4);
    reqCard('<h2>' + nice(p.asked) + '</h2><p class="busy">Being made: usually about 10 minutes' +
      (mins > 0 ? ' (' + mins + ' min so far)' : '') + '.</p>' +
      '<p class="note">This page checks every 30 seconds and opens the date when it is ready. You can keep using the map.</p>' +
      backLink());
    wireBack();
    S.waitTimer = setTimeout(function () { poll(p); }, 30000);
  }

  function poll(p) {
    var kind = /_imerg$/.test(p.run) ? 'observed' : 'forecast';
    refreshIndex().then(function () {
      var r = (S.byDate[p.issue] || {})[kind];
      if (r && (r.made || '') !== p.prev) {
        savePending(null);
        S.day = p.asked > p.issue ? Math.min(3, Math.round((Date.parse(p.asked) - Date.parse(p.issue)) / 864e5)) : S.day;
        return openDate(p.issue, kind);
      }
      return fetch(S.od.worker_url.replace(/\/$/, '') + '/status?date=' + p.issue).then(function (x) { return x.json(); }).then(function (s) {
        if (s.status === 'failed') failCard(p.asked, 'The prediction for this date could not be made.', true);
        else if (s.status === 'done' && Date.now() - Date.parse(s.finished) > 5 * 6e4) {
          // the run finished a while ago without a new version: nothing new could be made yet
          failCard(p.asked, 'Nothing new could be made for this date yet (for a recent date, the satellite rain for ' +
            'the following days is usually in about 5 days later).', false);
        } else if (Date.now() - p.since > 45 * 6e4) failCard(p.asked, 'This is taking much longer than usual.', true);
        else waitFor(p);
      });
    }).catch(function () { waitFor(p); });
  }

  function refreshIndex() {
    return fetch('data/index.json?t=' + Date.now(), {cache: 'no-store'}).then(function (r) { return r.json(); }).then(function (idx) {
      S.idx.runs = idx.runs; indexRuns(idx);
      if (S.run) renderBar();
    });
  }

  function savePending(p) {
    try { if (p) localStorage.setItem('ondemand', JSON.stringify(p)); else localStorage.removeItem('ondemand'); } catch (e) { /* private mode */ }
  }
  function loadPending() {
    try {
      var p = JSON.parse(localStorage.getItem('ondemand') || 'null');
      return p && S.od && Date.now() - p.since < 60 * 6e4 ? p : null;
    } catch (e) { return null; }
  }

  function latestDate() {
    // the newest forecast date if there is one, else the newest date
    for (var i = S.dates.length - 1; i >= 0; i--) if (S.byDate[S.dates[i]].forecast) return S.dates[i];
    return S.dates[S.dates.length - 1];
  }

  function openDate(date, rain) {
    var e = S.byDate[date];
    var r = (rain === 'observed' && e.observed) || (rain === 'forecast' && e.forecast) || e.forecast || e.observed;
    return openRun(r.id);
  }

  function openRun(id) {
    var p = S.summaries[id] ? Promise.resolve(S.summaries[id]) : getJSON('data/runs/' + id + '/summary.json');
    return p.then(function (s) {
      S.summaries[id] = s; S.run = s;
      renderBar(); renderPanel(); showOverlay(); writeHash();
      if (map._popup) map.closePopup();
      if (S.placeMarker) { map.removeLayer(S.placeMarker); S.placeMarker = null; }
      loadLookup(id);
    });
  }

  function stepDate(k) {
    var i = S.dates.indexOf(S.run.issue_date) + k;
    if (i >= 0 && i < S.dates.length) openDate(S.dates[i], S.run.hindcast ? 'observed' : 'forecast');
  }

  // ------------------------------------------------------------------ bar
  function renderBar() {
    var r = S.run;
    $('dateTxt').textContent = 'Issued ' + nice(r.issue_date);
    var i = S.dates.indexOf(r.issue_date);
    $('prevBtn').disabled = i <= 0; $('nextBtn').disabled = i >= S.dates.length - 1;
    var e = S.byDate[r.issue_date];
    var both = e.forecast && e.observed;
    $('rainCtl').hidden = !both;
    if (both) {
      $('rainSeg').innerHTML = '';
      [['forecast', 'Forecast'], ['observed', 'Observed (hindcast)']].forEach(function (o) {
        var b = document.createElement('button'); b.type = 'button'; b.textContent = o[1];
        b.className = (r.hindcast ? 'observed' : 'forecast') === o[0] ? 'on' : '';
        b.setAttribute('aria-pressed', b.className === 'on');
        b.addEventListener('click', function () { openRun(e[o[0]].id); });
        $('rainSeg').appendChild(b);
      });
    }
    $('daySeg').innerHTML = '';
    r.days.forEach(function (d) {
      var b = document.createElement('button'); b.type = 'button';
      b.innerHTML = 'Day ' + d.day + '<span class="sub">' + nice(d.date, false) + '</span>';
      b.className = d.day === S.day ? 'on' : '';
      b.setAttribute('aria-pressed', d.day === S.day);
      b.addEventListener('click', function () { S.day = d.day; renderBar(); renderPanel(); showOverlay(); writeHash(); });
      $('daySeg').appendChild(b);
    });
  }

  // ------------------------------------------------------------------ calendar
  function toggleCal() { if ($('cal').hidden) openCal(); else closeCal(); }
  function closeCal() { $('cal').hidden = true; $('dateBtn').setAttribute('aria-expanded', 'false'); }
  function openCal() {
    var d = pd(S.run.issue_date); S.calMonth = {y: d.y, m: d.m}; S.calView = 'days';
    renderCal(); $('cal').hidden = false; $('dateBtn').setAttribute('aria-expanded', 'true');
  }
  // the calendar covers 1 Aug 2000 (or the first date with data) to 3 days ahead
  function calFirst() { var f = S.od ? S.od.earliest : S.dates[0]; return S.dates[0] < f ? S.dates[0] : f; }
  function calLast() { var l = addDays(todayUTC(), S.od ? S.od.days_ahead : 0), m = S.dates[S.dates.length - 1]; return m > l ? m : l; }
  function ym(s) { var d = pd(s); return d.y * 12 + d.m; }
  function maxAlert(e) { return Math.max(e.forecast ? e.forecast.max_alert : 0, e.observed ? e.observed.max_alert : 0); }
  function renderCal() {
    if (S.calView === 'months') return renderMonths();
    if (S.calView === 'years') return renderYears();
    var c = S.calMonth, first = new Date(Date.UTC(c.y, c.m, 1)), days = new Date(Date.UTC(c.y, c.m + 1, 0)).getUTCDate();
    var lead = (first.getUTCDay() + 6) % 7;   // Monday first
    var cur = c.y * 12 + c.m, lo = ym(calFirst()), hi = ym(calLast());
    var h = '<div class="hd"><button type="button" data-mv="-1" aria-label="Previous month"' + (cur <= lo ? ' disabled' : '') + '>&#8249;</button>' +
            '<button type="button" class="ttl" data-view="months" title="Choose a month">' + MONTHS_LONG[c.m] + ' ' + c.y + ' &#9662;</button>' +
            '<button type="button" data-mv="1" aria-label="Next month"' + (cur >= hi ? ' disabled' : '') + '>&#8250;</button></div>' +
            '<table><tr>' + ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(function (x) { return '<th>' + x + '</th>'; }).join('') + '</tr><tr>';
    for (var i = 0; i < lead; i++) h += '<td></td>';
    for (var d = 1; d <= days; d++) {
      var s = iso(c.y, c.m, d), e = S.byDate[s];
      if ((lead + d - 1) % 7 === 0 && d > 1) h += '</tr><tr>';
      if (e) {
        var cls = 'has' + (!e.forecast ? ' hc' : '') + (s === S.run.issue_date ? ' sel' : '');
        var tip = (e.forecast ? 'forecast' : '') + (e.forecast && e.observed ? ' and ' : '') + (e.observed ? 'hindcast (observed rain)' : '');
        h += '<td><button type="button" class="' + cls + '" data-date="' + s + '" style="--dot:' + N.alert_colors[maxAlert(e)] +
             '" title="' + nice(s) + ': ' + tip + '">' + d + '</button></td>';
      } else if (aheadDay(s)) {
        h += '<td><button type="button" class="has ahead" data-ahead="' + s + '" style="--dot:' + N.alert_colors[S.byDate[todayUTC()].forecast.max_alert] +
             '" title="' + nice(s) + ': day ' + aheadDay(s) + ' of today’s forecast">' + d + '</button></td>';
      } else if (canRequest(s)) {
        h += '<td><button type="button" class="req" data-req="' + s + '" title="' + nice(s) + ': no prediction yet, click to make one">' + d + '</button></td>';
      } else {
        h += '<td><button type="button" disabled>' + d + '</button></td>';
      }
    }
    h += '</tr></table><div class="key">Bold dates have data; the dot shows the highest alert on days 1 to 3. ' +
         'Dashed: hindcast only (observed rain).' +
         (S.od ? ' Other dates from ' + nice(S.od.earliest) + ' to 3 days ahead can be made on request (about 10 minutes).' : '') + '</div>';
    h += '<div class="jump"><select aria-label="Jump to a date with data"><option value="">Jump to a date…</option>' +
         S.dates.slice().reverse().map(function (s) {
           return '<option value="' + s + '">' + nice(s) + (S.byDate[s].forecast ? '' : ' (hindcast)') + '</option>'; }).join('') +
         '</select></div>';
    var cal = $('cal'); cal.innerHTML = h;
    wireCalNav(cal);
    cal.querySelectorAll('[data-date]').forEach(function (b) {
      b.addEventListener('click', function () { closeCal(); openDate(b.getAttribute('data-date'), S.run.hindcast ? 'observed' : 'forecast'); });
    });
    cal.querySelectorAll('[data-ahead]').forEach(function (b) {
      b.addEventListener('click', function () { closeCal(); openAhead(b.getAttribute('data-ahead')); });
    });
    cal.querySelectorAll('[data-req]').forEach(function (b) {
      b.addEventListener('click', function () { closeCal(); showRequest(b.getAttribute('data-req')); });
    });
    cal.querySelector('.jump select').addEventListener('change', function () {
      if (this.value) { closeCal(); openDate(this.value, 'forecast'); }
    });
  }

  function wireCalNav(cal) {
    cal.querySelectorAll('[data-mv]').forEach(function (b) {
      b.addEventListener('click', function () {
        var m = S.calMonth.m + (+b.getAttribute('data-mv'));
        S.calMonth = {y: S.calMonth.y + Math.floor(m / 12), m: (m + 12) % 12}; renderCal();
      });
    });
    cal.querySelectorAll('[data-view]').forEach(function (b) {
      b.addEventListener('click', function () { S.calView = b.getAttribute('data-view'); renderCal(); });
    });
  }
  function monthHasData(y, m) {
    var pre = y + '-' + String(m + 1).padStart(2, '0');
    return S.dates.some(function (s) { return s.slice(0, 7) === pre; });
  }
  function renderMonths() {
    var y = S.calMonth.y, lo = ym(calFirst()), hi = ym(calLast()), fy = pd(calFirst()).y, ly = pd(calLast()).y;
    var h = '<div class="hd"><button type="button" data-yr="-1" aria-label="Previous year"' + (y <= fy ? ' disabled' : '') + '>&#8249;</button>' +
            '<button type="button" class="ttl" data-view="years" title="Choose a year">' + y + ' &#9662;</button>' +
            '<button type="button" data-yr="1" aria-label="Next year"' + (y >= ly ? ' disabled' : '') + '>&#8250;</button></div><div class="grid g3">';
    for (var m = 0; m < 12; m++) {
      var k = y * 12 + m, ok = k >= lo && k <= hi;
      h += '<button type="button" data-mon="' + m + '"' + (ok ? '' : ' disabled') +
           ' class="' + (monthHasData(y, m) ? 'has' : '') + (m === S.calMonth.m ? ' sel' : '') + '">' + MONTHS[m] + '</button>';
    }
    h += '</div><div class="key">Bold months have dates with data.</div>';
    var cal = $('cal'); cal.innerHTML = h;
    cal.querySelectorAll('[data-yr]').forEach(function (b) {
      b.addEventListener('click', function () { S.calMonth = {y: S.calMonth.y + (+b.getAttribute('data-yr')), m: S.calMonth.m}; renderCal(); });
    });
    cal.querySelectorAll('[data-mon]').forEach(function (b) {
      b.addEventListener('click', function () { S.calMonth = {y: S.calMonth.y, m: +b.getAttribute('data-mon')}; S.calView = 'days'; renderCal(); });
    });
    wireCalNav(cal);
  }
  function renderYears() {
    var fy = pd(calFirst()).y, ly = pd(calLast()).y, h = '<div class="hd"><span></span><b>' + fy + ' to ' + ly + '</b><span></span></div><div class="grid g4">';
    for (var y = ly; y >= fy; y--) {
      var data = S.dates.some(function (s) { return +s.slice(0, 4) === y; });
      h += '<button type="button" data-year="' + y + '" class="' + (data ? 'has' : '') + (y === S.calMonth.y ? ' sel' : '') + '">' + y + '</button>';
    }
    h += '</div><div class="key">Bold years have dates with data.</div>';
    var cal = $('cal'); cal.innerHTML = h;
    cal.querySelectorAll('[data-year]').forEach(function (b) {
      b.addEventListener('click', function () {
        var y = +b.getAttribute('data-year'), lo = ym(calFirst()), hi = ym(calLast()), k = Math.min(Math.max(y * 12 + S.calMonth.m, lo), hi);
        S.calMonth = {y: Math.floor(k / 12), m: k % 12}; S.calView = 'months'; renderCal();
      });
    });
  }

  // ------------------------------------------------------------------ overlays and legend
  function layerUrl(key) {
    var st = S.idx.static;
    if (key === 'prio' || key === 'alert' || key === 'prob') return 'data/runs/' + S.run.id + '/' + key + S.day + '.png';
    if (key === 'impact') return 'data/static/' + st.layers[runDay().yatra && st.layers.impact_yatra ? 'impact_yatra' : 'impact'];
    return 'data/static/' + st.layers[key];
  }
  function showOverlay() {
    var url = layerUrl(S.layer);
    if (url === S.overlayUrl) { refreshLegend(); return; }
    var old = S.overlay;
    var ov = L.imageOverlay(url, S.bounds, {className: 'px', interactive: false, opacity: S.opacity});
    ov.once('load error', function () { if (old) map.removeLayer(old); });
    ov.addTo(map);
    S.overlay = ov; S.overlayUrl = url;
    refreshLegend();
  }
  function setBase(key) {
    if (S.base) map.removeLayer(S.bases[S.base]);
    S.base = key; $('baseSel').value = key;
    S.bases[key].addTo(map);
  }
  function addLegend() {
    var Legend = L.Control.extend({options: {position: 'bottomright'}, onAdd: function () {
      var d = L.DomUtil.create('div'); d.innerHTML = S.idx.legend_html;
      var lg = d.firstElementChild;
      var t = L.DomUtil.create('span', 'lg-tg'); t.setAttribute('role', 'button'); t.tabIndex = 0;
      lg.insertBefore(t, lg.firstChild);
      function tg() { lg.classList.toggle('min'); t.textContent = lg.classList.contains('min') ? 'Legend ▸' : 'Legend ▾'; }
      t.addEventListener('click', tg); t.addEventListener('keydown', function (e) { if (e.key === 'Enter') tg(); });
      if (window.innerWidth < 760) lg.classList.add('min');
      t.textContent = lg.classList.contains('min') ? 'Legend ▸' : 'Legend ▾';
      L.DomEvent.disableClickPropagation(lg); L.DomEvent.disableScrollPropagation(lg);
      return lg;
    }});
    new Legend().addTo(map);
  }
  function refreshLegend() {
    document.querySelectorAll('#lg .lg-sec').forEach(function (s) {
      s.classList.toggle('on', s.getAttribute('data-legend') === S.layer);
    });
    var note = document.querySelector('#lg .lg-sec[data-legend="impact"] .lg-yatra');
    var sec = document.querySelector('#lg .lg-sec[data-legend="impact"]');
    if (sec) {
      if (!note) { note = document.createElement('div'); note.className = 'lg-note lg-yatra'; sec.appendChild(note); }
      note.textContent = runDay().yatra ? 'Yatra-month impact (pilgrims and pilgrim traffic included) for ' + nice(runDay().date) + '.'
                                        : 'Year-round impact (not a yatra month) for ' + nice(runDay().date) + '.';
    }
  }
  function addDistricts(gj) {
    L.geoJSON(gj, {
      style: {color: '#222', weight: 1.2, fill: true, fillOpacity: 0},
      onEachFeature: function (f, lay) {
        S.distLayers[f.properties.district] = lay;
        lay.bindTooltip(f.properties.district, {sticky: true});
        lay.on('mouseover', function () { lay.setStyle({weight: 3}); });
        lay.on('mouseout', function () { lay.setStyle({weight: 1.2}); });
      }
    }).addTo(map);
  }

  // ------------------------------------------------------------------ panel
  function renderPanel() { renderHead(); renderDistSel(); renderPlaces(); renderDistricts(); renderDownloads(); }

  function renderHead() {
    var r = S.run, d = runDay();
    var badge = r.hindcast ? '<span class="badge hc">hindcast: observed rain</span>' : '<span class="badge">forecast</span>';
    $('runHead').innerHTML = '<h2>Issued ' + nice(r.issue_date) + ' ' + badge + '</h2>' +
      '<div>Day ' + d.day + ': <b>' + nice(d.date) + '</b>' + (d.yatra ? ' (yatra month)' : '') +
      (d.extreme ? ' <b style="color:#b2182b">extreme day</b>' : '') + '</div>' +
      '<div class="stats">' +
      '<div><b>' + d.rain_mean.toFixed(1) + ' mm</b><span>state mean rain</span></div>' +
      '<div><b>' + pct(d.share.red) + '</b><span>area at red</span></div>' +
      '<div><b>' + pct(d.p_share.p1) + '</b><span>area at P1</span></div>' +
      '<div><b>' + num(d.places_by_priority.p1) + '</b><span>places at P1</span></div></div>';
    var imp = improvement(r.issue_date);
    if (imp) {
      $('runHead').insertAdjacentHTML('beforeend', '<div class="hint"><span>' + imp.text + '</span> ' +
        '<button type="button" id="impBtn">' + imp.label + '</button></div>');
      $('impBtn').addEventListener('click', function () { ask(r.issue_date); });
    }
  }

  function renderDistSel() {
    var sel = $('distSel'), cur = sel.value;
    var ds = (S.run.districts[String(S.day)] || []).map(function (x) { return x.district; });
    sel.innerHTML = '<option value="">Whole state (top 50)</option>' + ds.map(function (x) {
      return '<option value="' + esc(x) + '">' + esc(x) + '</option>'; }).join('');
    sel.value = ds.indexOf(cur) >= 0 ? cur : '';
  }

  function renderPlaces() {
    var d = runDay(), dist = $('distSel').value, hide = $('hideNone').checked;
    var rows = d.places.filter(function (p) { return dist ? p.district === dist : p.in_state_top; });
    var all = rows.length;
    if (hide) rows = rows.filter(function (p) { return p.priority > 0; });
    var note;
    if (hide && !rows.length) note = 'No ' + (dist ? 'place in ' + esc(dist) : 'listed place') + ' reaches a priority level on ' +
      nice(d.date) + '. Untick “Only places with a priority” to see the places ranked highest by probability x impact.';
    else if (hide && rows.length < all) note = (all - rows.length) + ' listed place' + (all - rows.length > 1 ? 's' : '') +
      ' with no priority on this day hidden.';
    else if (!hide) note = 'Places are ranked by probability x impact. The list is always filled, even on dry days; ' +
      '“none” means the place is not a priority on this day.';
    $('placeNote').innerHTML = note || '';
    $('placeTbl').querySelector('tbody').innerHTML = rows.map(function (p, i) {
      var sub = esc(p.district) + (p.road ? ' · ' + esc(p.road) : '');
      return '<tr tabindex="0" data-i="' + d.places.indexOf(p) + '"><td>' + (dist ? p.district_rank : p.rank) + '</td>' +
        '<td class="l">' + esc(p.place) + '<span class="sub">' + sub + '</span></td><td>' + prioChip(p.priority) + '</td><td>' +
        alertChip(p.alert) + '</td><td>' + num(p.people_in_path) + '</td></tr>';
    }).join('');
    $('placeTbl').querySelectorAll('tbody tr').forEach(function (tr) {
      function go() { selectPlace(d.places[+tr.getAttribute('data-i')], tr); }
      tr.addEventListener('click', go);
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
  }

  function placeHtml(p) {
    var h = '<div class="pp"><b>' + esc(p.place) + '</b>, ' + esc(p.district) + '<table class="kv">' +
      '<tr><td>Priority</td><td>' + prioChip(p.priority) + ' (state rank ' + p.rank + ', district rank ' + p.district_rank + ')</td></tr>' +
      '<tr><td>Hazard</td><td>' + alertChip(p.alert) + ' probability ' + fmtP(p.prob) + '</td></tr>' +
      '<tr><td>Impact</td><td>' + esc(N.impact[p.impact_class] || '-') + (p.exposed ? ' (' + esc(p.exposed) + ')' : '') + '</td></tr>' +
      '<tr><td>In the path</td><td>' + num(p.people_in_path) + ' people in homes</td></tr>';
    if (p.road) {
      h += '<tr><td>Road</td><td>If ' + esc(p.road) + ' is blocked: ' + num(p.road_cut_off) + ' people cut off, ' +
           num(p.road_detour) + ' on a long detour' + (p.road_note ? '<br><span style="color:#555">' + esc(p.road_note) + '</span>' : '') + '</td></tr>';
    }
    h += '<tr><td>Cells</td><td>' + p.cells + ' cells, ' + p.p1_cells + ' at P1, ' + p.red_cells + ' red</td></tr>';
    if (p.factors) h += '<tr><td>Top factors</td><td>' + esc(p.factors) + '</td></tr>';
    return h + '</table></div>';
  }

  function selectPlace(p, tr) {
    document.querySelectorAll('#placeTbl tr.sel').forEach(function (x) { x.classList.remove('sel'); });
    if (tr) tr.classList.add('sel');
    var ll = L.latLng(p.lat, p.lon);
    if (S.placeMarker) map.removeLayer(S.placeMarker);
    S.placeMarker = L.circleMarker(ll, {radius: 9, color: '#000', weight: 2, fill: false, interactive: false}).addTo(map);
    map.setView(ll, S.idx.place_zoom);
    L.popup({maxWidth: 360}).setLatLng(ll).setContent(placeHtml(p)).openOn(map);
    S.selPlace = p;
    if (window.innerWidth < 760) $('map').scrollIntoView({block: 'start'});
  }

  function renderDistricts() {
    var rows = S.run.districts[String(S.day)] || [];
    $('distTbl').querySelector('tbody').innerHTML = rows.map(function (r, i) {
      return '<tr tabindex="0" data-d="' + esc(r.district) + '"><td class="l">' + esc(r.district) + '</td><td>' + pct(r.p1) + '</td><td>' +
        pct(r.red) + '</td><td>' + alertChip(r.max_alert) + '</td><td class="l">' + (r.top_place ? esc(r.top_place) +
        ' <span class="sub">' + (N.prio[r.top_priority] || 'none') + '</span>' : '-') + '</td></tr>';
    }).join('');
    $('distTbl').querySelectorAll('tbody tr').forEach(function (tr) {
      function go() {
        var lay = S.distLayers[tr.getAttribute('data-d')];
        if (lay) { map.fitBounds(lay.getBounds()); if (window.innerWidth < 760) $('map').scrollIntoView({block: 'start'}); }
      }
      tr.addEventListener('click', go);
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    });
  }

  var DL_NAMES = {
    'district_summary.csv': 'District summary, days 1 to 3 (CSV)',
    'susceptibility.tif': 'Susceptibility score (GeoTIFF, static)',
    'long_term_risk.tif': 'Long-term risk (GeoTIFF, static)'
  };
  function dlName(f) {
    var b = f.split('/').pop(), m;
    if (DL_NAMES[b]) return DL_NAMES[b];
    if ((m = b.match(/^priority_places_d(\d)\.csv$/))) return 'Place list, day ' + m[1] + ' (CSV)';
    if ((m = b.match(/^priority_d(\d)\.tif$/))) return 'Priority, day ' + m[1] + ' (GeoTIFF)';
    if ((m = b.match(/^alert_d(\d)\.tif$/))) return 'Hazard alert, day ' + m[1] + ' (GeoTIFF)';
    if ((m = b.match(/^prob_d(\d)\.tif$/))) return 'Probability, day ' + m[1] + ' (GeoTIFF)';
    return b;
  }
  function kb(x) { return x >= 1024 ? (x / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(x)) + ' KB'; }
  function renderDownloads() {
    var h = S.run.downloads.map(function (d) {
      return '<li><a href="data/runs/' + S.run.id + '/' + d.file + '" download>' + esc(dlName(d.file)) + '</a> <span class="kb">' + kb(d.kb) + '</span></li>';
    }).concat(S.idx.static.downloads.map(function (d) {
      return '<li><a href="data/static/' + d.file + '" download>' + esc(dlName(d.file)) + '</a> <span class="kb">' + kb(d.kb) + '</span></li>';
    }));
    $('dlList').innerHTML = h.join('') + '<li style="list-style:none;color:#5b5b60;font-size:12px;margin-top:4px">GeoTIFFs are on a 250 m grid in UTM 44N ' +
      '(EPSG:32644). Priority: 1 to 3, 0 none; alert: 0 green to 3 red; 255 outside the state.</li>';
  }

  function renderFooter() {
    $('foot').innerHTML = '<p><b>Research model, not an official warning.</b> Do not use this map to decide whether a place is safe. ' +
      'For official warnings and advice follow ' + $('official').innerHTML + '.</p>' +
      '<p>Data: NASA GPM IMERG rain; ECMWF IFS and NOAA GFS forecasts via Open-Meteo; Copernicus GLO-30 DEM; ESA WorldCover; ' +
      'Hansen Global Forest Change; MODIS NDVI; SoilGrids; OpenStreetMap contributors; Google Open Buildings; JRC GHS-POP; ' +
      'ISRO/NRSC Bhuvan landslide inventory; NASA COOLR; GEM seismic hazard (non-commercial licence); UDISE school list. ' +
      'Base map &copy; Esri. Map library Leaflet.</p>' +
      '<p>Site built ' + esc(S.idx.built.replace('T', ' ').replace('Z', ' UTC')) + '. ' + S.idx.runs.length + ' runs.</p>';
  }

  // ------------------------------------------------------------------ click lookup
  var CTOR = {uint8: Uint8Array, uint16: Uint16Array, uint32: Uint32Array, float32: Float32Array};
  function inflate(buf, a) {   // one zlib stream of the lookup blob -> typed array
    var ds = new Blob([new Uint8Array(buf, a.offset, a.length)]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Response(ds).arrayBuffer().then(function (out) { return new CTOR[a.dtype](out); });
  }
  var staticStrings = null;
  function loadLookup(id) {
    if (S.lookups[id]) return S.lookups[id];
    if (!staticStrings) {
      staticStrings = getJSON('data/static/' + S.idx.static.strings);
      staticStrings.catch(function () { staticStrings = null; });
    }
    var base = 'data/runs/' + id + '/';
    S.lookups[id] = Promise.all([
      getJSON(base + 'lookup.json'),
      fetch(base + 'lookup.bin').then(function (r) { if (!r.ok) throw new Error('lookup.bin: ' + r.status); return r.arrayBuffer(); }),
      staticStrings
    ]).then(function (res) {
      var lk = res[0], buf = res[1], names = Object.keys(lk.arrays);
      return Promise.all(names.map(function (n) { return inflate(buf, lk.arrays[n]); })).then(function (vals) {
        var A = {}; names.forEach(function (n, i) { A[n] = vals[i]; });
        return {grid: lk.grid, A: A, exposed: lk.exposed, road: res[2].road, note: res[2].road_note,
                districts: lk.districts, factors: lk.factors, pc: lk.prob_code};
      });
    });
    S.lookups[id].catch(function () { delete S.lookups[id]; });
    return S.lookups[id];
  }

  function onMapClick(e) {
    var run = S.run, day = S.day;
    var pop = L.popup({maxWidth: 400}).setLatLng(e.latlng).setContent('<div class="pp">Loading…</div>').openOn(map);
    loadLookup(run.id).then(function (lk) {
      if (S.run !== run) return;
      pop.setContent(cellHtml(lk, e.latlng, day));
    }).catch(function (err) { pop.setContent('<div class="pp">Cell data could not be loaded (' + esc(err.message) + ').</div>'); });
  }

  function cellHtml(lk, ll, day) {
    var g = lk.grid, A = lk.A, lat = ll.lat, lon = ll.lng;
    var i = Math.floor((g.north - lat) / g.step), j = Math.floor((lon - g.west) / g.step);
    var h = '<div class="pp"><b>' + lat.toFixed(4) + ' N, ' + lon.toFixed(4) + ' E</b>';
    if (i < 0 || j < 0 || i >= g.nrow || j >= g.ncol || A.dist[i * g.ncol + j] === 0) return h + '<br>Outside Uttarakhand (no prediction).</div>';
    var q = i * g.ncol + j, d = S.run.days[day - 1];
    var imp = d.yatra ? A.is[q] : A.iy[q];
    function P(k) { var c = A['p' + k][q]; return c ? Math.pow(10, c / lk.pc.scale - lk.pc.offset) : 0; }
    var ex = d.yatra ? A.es[q] : A.ey[q];
    h += '<h5>Most urgent 250 m cell in this ~1 km square (' + A.ncell[q] + ' cells)</h5>' +
         '<table class="kv"><tr><td>District</td><td>' + esc(lk.districts[A.dist[q] - 1]) + '</td></tr>' +
         '<tr><td>Priority, day ' + day + '</td><td>' + prioChip(A['q' + day][q]) + '</td></tr>' +
         '<tr><td>Hazard, day ' + day + '</td><td>' + alertChip(A['a' + day][q]) + ' probability ' + fmtP(P(day)) + '</td></tr>' +
         '<tr><td>Impact</td><td>' + esc(N.impact[imp] || '-') + (ex ? ' (' + esc(lk.exposed[ex - 1]) + ')' : '') + '</td></tr>' +
         '<tr><td>In the path</td><td>' + num(A.pp[q]) + ' people in homes</td></tr>';
    if (A.rd[q]) {
      h += '<tr><td>Road</td><td>If ' + esc(lk.road[A.rd[q] - 1]) + ' is blocked: ' + num(A.co[q]) + ' people cut off, ' +
           num(A.de[q]) + ' on a long detour' + (A.rn[q] ? '<br><span style="color:#555">' + esc(lk.note[A.rn[q] - 1]) + '</span>' : '') + '</td></tr>';
    }
    h += '<tr><td>Susceptibility</td><td>' + esc(N.susc[A.susc[q]] || '-') + '</td></tr></table>';
    h += '<table><tr><th>day</th><th>rain</th><th>prob.</th><th>alert</th><th>priority</th></tr>';
    for (var k = 1; k <= 3; k++) {
      h += '<tr' + (k === day ? ' style="font-weight:600"' : '') + '><td>' + nice(S.run.days[k - 1].date, false) + (A.peak[q] === k ? ' *' : '') +
           '</td><td>' + (A['r' + k][q] / 10).toFixed(1) + ' mm</td><td>' + fmtP(P(k)) + '</td><td>' + alertChip(A['a' + k][q]) +
           '</td><td>' + prioChip(A['q' + k][q]) + '</td></tr>';
    }
    h += '</table>';
    var f = [A.f1[q], A.f2[q], A.f3[q]].filter(function (x) { return x > 0; }).map(function (x) { return esc(lk.factors[x - 1]); });
    if (f.length) h += 'Top factors on the peak day (*): ' + f.join('; ');
    return h + '</div>';
  }
})();
