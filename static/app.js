'use strict';
const $ = id => document.getElementById(id);
const navToggle = $('nav-toggle');
const mainNavigation = $('main-navigation');
const header = navToggle.closest('.header-inner');
const mobileNavigation = window.matchMedia('(max-width: 639.98px)');
function setNavigationOpen(open, restoreFocus = false) {
  header.classList.toggle('menu-open', open);
  navToggle.setAttribute('aria-expanded', String(open));
  navToggle.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');
  if (restoreFocus && mobileNavigation.matches) navToggle.focus();
}
navToggle.addEventListener('click', () => setNavigationOpen(navToggle.getAttribute('aria-expanded') !== 'true'));
mainNavigation.addEventListener('click', event => {
  if (event.target.closest('a')) setNavigationOpen(false, true);
});
document.addEventListener('pointerdown', event => {
  if (!header.contains(event.target)) setNavigationOpen(false, mainNavigation.contains(document.activeElement));
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && navToggle.getAttribute('aria-expanded') === 'true') {
    event.preventDefault();
    setNavigationOpen(false, true);
  }
});
header.addEventListener('focusout', event => {
  if (event.relatedTarget && !header.contains(event.relatedTarget)) setNavigationOpen(false);
});
mobileNavigation.addEventListener('change', () => setNavigationOpen(false, mainNavigation.contains(document.activeElement)));
let devices = [], editing = null, deleting = null, timer, currentTab = 'device';
let equipmentPageSummary = null;
let networkLoaded = false;
let overviewVersion = 0;
async function loadOverview() {
  const version = ++overviewVersion;
  try {
    const totals = await api('/api/overview');
    if (version !== overviewVersion) return;
    $('overview-av-validated').textContent = totals.av_validated;
    $('overview-av-caption').textContent = totals.av_validated === 1 ? 'IP validated' : 'IPs validated';
    $('overview-av-total').textContent = `${totals.av_validated} of ${totals.av_total} ${totals.av_total === 1 ? 'device' : 'devices'}`;
    $('overview-iptv-total').textContent = totals.iptv_total;
    $('overview-iptv-caption').textContent = totals.iptv_total === 1 ? 'channel running' : 'channels running';
    $('overview-iptv-sources').textContent = `${totals.iptv_onboard} onboard · ${totals.iptv_satellite} satellite`;
    $('overview-inventory-total').textContent = totals.inventory_total;
    $('overview-inventory-locations').textContent = `${totals.inventory_total === 1 ? 'item' : 'items'} across ${totals.inventory_locations} ${totals.inventory_locations === 1 ? 'location' : 'locations'}`;
    $('overview-inventory-count').textContent = `${totals.inventory_count} ${totals.inventory_count === 1 ? 'inventory' : 'inventories'}`;
    $('overview-error').hidden = true;
  } catch (error) {
    if (version !== overviewVersion) return;
    for (const id of ['overview-av-validated','overview-iptv-total','overview-inventory-total']) $(id).textContent = '—';
    $('overview-error').textContent = 'Could not refresh the workspace overview. Use Refresh to try again.';
    $('overview-error').hidden = false;
  }
}
function updatePageSummary(equipmentItems, inventoryName, profile = {}) {
  if (equipmentItems) equipmentPageSummary = {count:equipmentItems.length, locations:new Set(equipmentItems.map(item => item.location).filter(Boolean)).size, name:inventoryName,storage:profile.location_role!=='geographic'&&profile.location_role!=='none'&&!inventoryName?.toLowerCase().includes('scala')};
  $('workspace-page-title').textContent = currentTab === 'equipment' ? `Inventory${equipmentPageSummary ? ' · ' + equipmentPageSummary.name : ''}` : currentTab === 'iptv' ? 'IPTV' : 'AV Devices';
  if (currentTab === 'equipment') {
    $('workspace-page-summary').textContent = equipmentPageSummary
      ? `${equipmentPageSummary.count} ${equipmentPageSummary.count === 1 ? 'item' : 'items'}${equipmentPageSummary.storage ? ` across ${equipmentPageSummary.locations} ${equipmentPageSummary.locations === 1 ? 'location' : 'locations'}` : ''}`
      : 'Loading inventory…';
  } else if (!networkLoaded) {
    $('workspace-page-summary').textContent = currentTab === 'iptv' ? 'Loading IPTV channels…' : 'Loading AV devices…';
  } else if (currentTab === 'iptv') {
    const count = devices.filter(item => item.record_type === 'iptv').length;
    $('workspace-page-summary').textContent = `${count} ${count === 1 ? 'channel' : 'channels'} running`;
  } else {
    const count = devices.filter(item => (item.record_type || 'device') === 'device' && item.ip_confirmed && item.ip && !isDHCP(item.ip)).length;
    $('workspace-page-summary').textContent = `${count} ${count === 1 ? 'IP' : 'IPs'} validated`;
  }
}
let visibleDevices = [];
const networkSelections = {device:new Set(), iptv:new Set()};
let batchDeletingIds = [];
let importWarnings = [];
const pendingNoteSaves = new Map();
const pendingWrites = new Set();
const tabSortOrders = {device: '', iptv: ''};
const nameCollator = new Intl.Collator(undefined, {sensitivity: 'base', numeric: true});
const tabDevices = () => devices.filter(d => (d.record_type || 'device') === currentTab);
const form = $('device-form');
const filters = ['search', 'venue-filter', 'system-filter', 'source-filter', 'address-filter'];
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const systems = ['Video', 'Audio', 'Lighting', 'Control', 'Network', 'Other'];
const deviceLabel = device => device.name || `record ${device.id}`;
const isDHCP = value => value.trim().toUpperCase() === 'DHCP';
function compareDirectoryRecords(a, b, order) {
  const [field, direction] = order.split('-');
  const sign = direction === 'desc' ? -1 : 1;
  let comparison = 0;
  if (field === 'ip') {
    const number = ip => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split('.').every(octet => Number(octet) <= 255)
      ? ip.split('.').reduce((value, octet) => value * 256 + Number(octet), 0) : null;
    const left = number(a.ip), right = number(b.ip);
    // Static IPv4 addresses first, DHCP next, blank addresses last in either direction.
    const group = (record, value) => value !== null ? 0 : isDHCP(record.ip) ? 1 : 2;
    const grouping = group(a, left) - group(b, right);
    if (grouping) return grouping;
    if (left !== null && right !== null) comparison = left - right;
  } else {
    const key = field === 'system' ? (currentTab === 'iptv' ? 'channel_source' : 'discipline') : 'name';
    const left = (a[key] || '').trim(), right = (b[key] || '').trim();
    if (!left !== !right) return left ? -1 : 1;
    comparison = nameCollator.compare(left, right);
  }
  return comparison * sign || nameCollator.compare(a.name, b.name) || a.id - b.id;
}

let activeSystemMenu = null;
function closeSystemMenu(restoreFocus = false) {
  if (!activeSystemMenu) return;
  const {menu, button} = activeSystemMenu;
  activeSystemMenu = null; menu.remove(); button.setAttribute('aria-expanded', 'false');
  if (restoreFocus) button.focus();
}
document.addEventListener('pointerdown', event => {
  if (activeSystemMenu && !activeSystemMenu.menu.contains(event.target) && !activeSystemMenu.button.contains(event.target)) closeSystemMenu();
});
window.addEventListener('resize', () => activeSystemMenu?.position());
document.addEventListener('scroll', event => {
  if (activeSystemMenu && !activeSystemMenu.menu.contains(event.target)) activeSystemMenu.position();
}, true);
function systemDropdown(device) {
  const button = element('button', 'system-select system-tag');
  button.type = 'button'; button.dataset.value = device.discipline;
  button.setAttribute('role', 'combobox');
  button.setAttribute('aria-label', `System for ${deviceLabel(device)}`);
  button.setAttribute('aria-haspopup', 'listbox'); button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', `system-menu-${device.id}`);
  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  arrow.classList.add('system-arrow'); arrow.setAttribute('viewBox', '0 0 12 12');
  arrow.setAttribute('aria-hidden', 'true'); arrow.setAttribute('focusable', 'false');
  const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  chevron.setAttribute('d', 'M3 4.5 6 7.5 9 4.5'); arrow.append(chevron);
  button.append(element('span', '', device.discipline), arrow);
  const open = (last = false) => {
    closeSystemMenu();
    const menu = element('div', 'system-options'); menu.id = `system-menu-${device.id}`;
    menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', `Choose system for ${deviceLabel(device)}`);
    const choices = ['', ...systems].map(value => {
      const option = element('button', 'system-option system-tag', value || 'Clear system');
      option.type = 'button'; option.dataset.value = value; option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(value === device.discipline));
      option.onclick = async () => {
        closeSystemMenu(true); button.disabled = true;
        try {
          const updated = await api(`/api/devices/${device.id}/system`, 'POST', {discipline:value});
          devices = devices.map(row => row.id === updated.id ? {...row,discipline:updated.discipline} : row);
          updateFilterOptions(); render();
          document.querySelector(`.system-select[aria-controls="system-menu-${device.id}"]`)?.focus();
        } catch(error) { button.disabled = false; toast('Could not save system: ' + error.message); }
      };
      return option;
    });
    menu.append(...choices); document.body.append(menu);
    const position = () => {
      const rect = button.getBoundingClientRect(), width = Math.min(190, window.innerWidth - 16);
      menu.style.width = `${width}px`;
      menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
      const height = Math.min(menu.scrollHeight, window.innerHeight - 16);
      menu.style.top = `${Math.max(8, rect.bottom + height + 8 <= window.innerHeight ? rect.bottom + 4 : rect.top - height - 4)}px`;
      menu.style.maxHeight = `${window.innerHeight - 16}px`;
    };
    activeSystemMenu = {menu, button, position}; position(); button.setAttribute('aria-expanded', 'true');
    const selected = choices.find(option => option.dataset.value === device.discipline);
    (last ? choices.at(-1) : selected || choices[0]).focus();
    menu.onkeydown = event => {
      const index = choices.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); closeSystemMenu(true); }
      else if (event.key === 'Tab') closeSystemMenu(true);
      else if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length;
        choices[next].focus();
      }
    };
  };
  button.onclick = () => activeSystemMenu?.button === button ? closeSystemMenu() : open();
  button.onkeydown = event => {
    if (['ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); open(event.key === 'ArrowUp'); }
    else if (event.key === 'Escape') closeSystemMenu(true);
  };
  return button;
}
async function saveNotes(deviceId, notes) {
  const previous = pendingNoteSaves.get(deviceId) || Promise.resolve();
  const request = previous.catch(() => {}).then(() => api(`/api/devices/${deviceId}/notes`, 'POST', {notes}));
  pendingNoteSaves.set(deviceId, request);
  try { return await request; }
  finally { if (pendingNoteSaves.get(deviceId) === request) pendingNoteSaves.delete(deviceId); }
}
const cleanVenue = value => value.trim().replace(/^RD\s+/i, '').trim();
const venueColors = new Map();
const usedVenueColors = new Set();
function colorVenueButton(button, venue) {
  if (!venue) return;
  if (!venueColors.has(venue)) {
    let hash = 2166136261;
    for (const character of venue) hash = Math.imul(hash ^ character.codePointAt(0), 16777619) >>> 0;
    let hue = hash % 360;
    const saturation = 60 + (hash >>> 8) % 16, lightness = 65 + (hash >>> 16) % 10;
    let color = `hsl(${hue} ${saturation}% ${lightness}%)`;
    while (usedVenueColors.has(color)) {
      hue += 0.1;
      color = `hsl(${hue} ${saturation}% ${lightness}%)`;
    }
    venueColors.set(venue, color);
    usedVenueColors.add(color);
  }
  button.classList.add('venue-choice');
  button.style.setProperty('--venue-color', venueColors.get(venue));
}
// IDs preserve first appearance across imports even when the device list is sorted.
const savedVenues = () => [...new Set(tabDevices().slice().sort((a,b) => a.id-b.id).map(d => cleanVenue(d.venue)).filter(Boolean))];
function makeButtons(id, values, selected, onSelect, allLabel = null) {
  const choices = allLabel ? [['', allLabel], ...values.map(v => [v, v])] : values.map(v => [v, v]);
  $(id).replaceChildren(...choices.map(([value, label]) => {
    const button = element('button', 'choice-button', label);
    button.type = 'button';
    button.dataset.value = value;
    if (id === 'form-venue-buttons') colorVenueButton(button, value);
    button.setAttribute('aria-pressed', String(value === selected));
    button.onclick = () => onSelect(value);
    return button;
  }));
}
function syncButtons(id, value) {
  $(id).querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.value === value)));
}
function updateVenueFilter() {
  const venues = savedVenues();
  const selected = $('venue-filter').value;
  $('venue-filter').replaceChildren(new Option('All venues', ''), ...venues.map(venue => {
    const option = new Option(venue, venue);
    colorVenueButton(option, venue);
    return option;
  }));
  $('venue-filter').value = venues.includes(selected) ? selected : '';
}
makeButtons('system-buttons', systems, '', value => { $('system-filter').value = value; render(); }, 'All systems');
makeButtons('source-buttons', ['Onboard','Satellite'], '', value => { $('source-filter').value = value; render(); }, 'All sources');
makeButtons('address-buttons', ['DHCP'], '', value => { $('address-filter').value = value; render(); }, 'All addresses');
makeButtons('form-source-buttons', ['Onboard','Satellite'], '', value => { form.elements.channel_source.value = form.elements.channel_source.value === value ? '' : value; syncButtons('form-source-buttons', form.elements.channel_source.value); });
function updateFilterOptions() {
  updateVenueFilter();
  $('venues').replaceChildren(...savedVenues().map(v => new Option(v, v)));
}
function switchTab(type) {
  closeSystemMenu();
  closeExportMenus();
  currentTab = type;
  $('homepage-overview').hidden = location.pathname === '/inventory' || Boolean(location.hash);
  updatePageSummary();
  const equipment = type === 'equipment';
  $('example-media').hidden = type === 'iptv';
  $('equipment-panel').hidden = !equipment;
  $('inventory').hidden = equipment;
  document.querySelector('main > .stats').hidden = equipment;
  for (const [id, tab] of [['device-tab','device'], ['iptv-tab','iptv'], ['equipment-tab','equipment']]) {
    $(id).classList.toggle('nav-active', tab === type);
    if (tab === type) $(id).setAttribute('aria-current', 'page');
    else $(id).removeAttribute('aria-current');
  }
  if (equipment) {
    $('hero-title').replaceChildren(document.createTextNode('Every asset.'), element('br'), document.createTextNode('Every location.'), element('br'), element('span', '', 'One clear view.'));
    $('hero-intro').textContent = 'Manage your broadcast equipment, spare stock, and production tools. Keep brands, models, serial numbers, and quantities organized from the control room to the storeroom.';
    $('example-ip').textContent = 'Advanced Panel 10'; $('example-name').textContent = 'Blackmagic Design';
    $('example-tags').replaceChildren(...['Video control panel','Quantity 1','Broadcast center'].map(text => element('span','',text)));
    $('add-device').textContent = 'Add equipment'; $('validation-note').hidden = true;
    window.equipmentUI.load(); return;
  }
  filters.forEach(id => $(id).value = '');
  $('inventory').setAttribute('aria-labelledby', type === 'iptv' ? 'iptv-tab' : 'device-tab');
  const iptv = type === 'iptv';
  $('inventory').querySelectorAll('.export-links a[download]').forEach(link => {
    const url = new URL(link.href); url.searchParams.set('record_type', type); link.href = url.href;
    const extension = url.pathname.split('.').pop();
    link.download = `broadcasthub-${iptv ? 'iptv-channels' : 'av-devices'}.${['csv','xlsx','pdf'].includes(extension) ? extension : 'json'}`;
  });
  $('sort-order').value = tabSortOrders[type];
  for (const direction of ['asc', 'desc']) {
    $('sort-order').querySelector(`option[value="system-${direction}"]`).textContent = `${iptv ? 'Source' : 'System'} · ${direction === 'asc' ? 'A–Z' : 'Z–A'}`;
  }

  $('hero-title').replaceChildren(document.createTextNode(iptv ? 'Every channel.' : 'Every device.'), element('br'), document.createTextNode(iptv ? 'Every source.' : 'Every venue.'), element('br'), element('span', '', 'One clear view.'));
  $('hero-intro').textContent = iptv ? 'Keep your onboard and satellite channel lineup in view. Track stream addresses and ports, organize channels by source, and take your inventory from the control room to your phone.' : 'Manage your broadcast equipment, channel lineups, and AV connections. Keep your production workspace organized from the control room to your phone.';
  $('example-ip').textContent = iptv ? '239.1.1.10' : '10.24.176.67';
  $('example-name').textContent = iptv ? 'Ship information' : 'ATEM 1 M/E Advanced Panel 10';
  $('example-tags').replaceChildren(...(iptv ? ['Onboard', 'Port 1234'] : ['Liquid Lounge', 'Video', 'VLAN 1500']).map(text => element('span', '', text)));

  $('add-device').textContent = iptv ? 'Add channel' : 'Add device';
  $('empty-add').textContent = iptv ? 'Add a channel' : 'Add a device';
  $('empty-title').textContent = iptv ? 'Your channel lineup starts here' : 'Your inventory starts here';
  $('empty-description').textContent = iptv ? 'Add onboard and satellite channel addresses to your IPTV inventory.' : 'Add your first device to keep your ship’s AV network organized.';
  $('use-example').hidden = iptv;
  $('total-label').textContent = iptv ? 'Total channels' : 'Total devices';
  $('system-count-label').textContent = iptv ? 'Onboard / Satellite' : 'Video / Audio / Lighting';
  $('list-title').textContent = iptv ? 'IPTV channels' : 'AV Devices';
  $('search-label').textContent = iptv ? 'Search channels' : 'Search devices';
  $('clear-filters').hidden = iptv;
  $('network-filters').classList.toggle('iptv-filters', iptv);
  $('search').placeholder = iptv ? 'Channel, IP, port, or notes…' : 'Name, IP, venue, or notes…';
  $('system-filter-group').hidden = $('system-filter-label').hidden = iptv;
  $('source-filter-group').hidden = !iptv;
  for (const id of ['venue-filter-group','venue-stat','vlan-stat','validation-note']) $(id).hidden = iptv;
  document.querySelector('.stats').classList.toggle('iptv-stats', iptv);
  $('confirmation-legend').textContent = iptv ? 'Channel addresses and stream ports · Onboard / Satellite' : 'Yellow: awaiting confirmation · Green: reachability confirmed';
  updateFilterOptions(); render();
}
const inventoryTabs = [['device-tab','device'],['iptv-tab','iptv'],['equipment-tab','equipment']];
function navigatePage(type) {
  const link = $(inventoryTabs.find(([,page]) => page === type)[0]);
  const destination = link.pathname + link.hash;
  if (location.pathname + location.hash !== destination) history.pushState(null, '', destination);
  switchTab(type);
}
function restorePage() {
  $('homepage-overview').hidden = location.pathname === '/inventory' || Boolean(location.hash);
  if (location.hash === '#equipment' || location.hash === '#inventory') history.replaceState(null, '', '/inventory');
  const page = location.pathname === '/inventory' ? inventoryTabs[2] : inventoryTabs.find(([id]) => $(id).hash && $(id).hash === location.hash) || (!location.hash ? inventoryTabs[0] : null);
  if (page && page[1] !== currentTab) switchTab(page[1]);
}
window.addEventListener('hashchange', restorePage);
window.addEventListener('popstate', restorePage);
window.addEventListener('DOMContentLoaded', restorePage);
document.querySelectorAll('.overview-card').forEach(link => {
  link.onclick = event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); navigatePage(link.dataset.page);
  };
});
for (const [id, type] of inventoryTabs) {
  $(id).onclick = event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); navigatePage(type);
  };
  $(id).onkeydown = event => {
    if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
      event.preventDefault();
      const index = inventoryTabs.findIndex(([,tab]) => tab === currentTab);
      const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
      const [nextId,next] = inventoryTabs[nextIndex]; navigatePage(next); $(nextId).focus();
    }
  };
}
function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(timer); timer = setTimeout(() => { $('toast').hidden = true; }, 6000);
}
async function api(path, method = 'GET', body) {
  const options = {method, headers: {'Content-Type': 'application/json'}};
  if (body !== undefined) options.body = JSON.stringify(body);
  const request = (async () => {
    const response = await fetch(path, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed. Please try again.');
    return data;
  })();
  if (method !== 'GET') pendingWrites.add(request);
  try { return await request; }
  finally { pendingWrites.delete(request); }
}
function closeExportMenus(restoreFocus = false) {
  document.querySelectorAll('.export-dropdown[open]').forEach(menu => {
    menu.open = false;
    if (restoreFocus && menu.contains(document.activeElement)) menu.querySelector('summary').focus();
  });
}
function updateExportScope(id, visible, selected, total) {
  const select = $(id);
  for (const [value, text] of [['filtered', `Current view · ${visible}`], ['selected', `Selected rows · ${selected}`], ['all', `All in this tab · ${total}`]]) {
    const option = select.querySelector(`option[value="${value}"]`);
    option.textContent = text;
    if (value === 'selected') option.disabled = !selected;
  }
  if (!selected && select.value === 'selected') select.value = 'filtered';
}
function selectionControl(id, name, selected, onChange) {
  const control = element('label', 'row-select-control');
  const checkbox = element('input', 'row-select');
  checkbox.type = 'checkbox'; checkbox.dataset.recordId = id;
  checkbox.checked = selected.has(id);
  checkbox.setAttribute('aria-label', `Select ${name}`);
  checkbox.onchange = () => {
    if (checkbox.checked) selected.add(id); else selected.delete(id);
    onChange();
  };
  control.append(checkbox);
  return control;
}
function updateNetworkSelection() {
  if (currentTab === 'equipment') return;
  const selected = networkSelections[currentTab];
  const check = $('select-visible-devices');
  const visibleSelected = visibleDevices.filter(row => selected.has(row.id)).length;
  check.disabled = !visibleDevices.length;
  check.checked = !!visibleDevices.length && visibleSelected === visibleDevices.length;
  check.indeterminate = visibleSelected > 0 && visibleSelected < visibleDevices.length;
  check.setAttribute('aria-label', `Select all visible ${currentTab === 'iptv' ? 'channels' : 'devices'}`);
  $('device-list').querySelectorAll('.row-select').forEach(checkbox => { checkbox.checked = selected.has(Number(checkbox.dataset.recordId)); });
  $('network-selection-summary').hidden = !selected.size;
  $('delete-selected-devices').disabled = !selected.size;
  $('network-selection-count').textContent = `${selected.size} selected`;
  updateExportScope('network-export-scope', visibleDevices.length, selected.size, tabDevices().length);
}
$('select-visible-devices').onchange = event => {
  const selected = networkSelections[currentTab];
  visibleDevices.forEach(row => event.target.checked ? selected.add(row.id) : selected.delete(row.id));
  if (selected.size) $('network-export-scope').value = 'selected';
  updateNetworkSelection();
};
$('clear-network-selection').onclick = () => { networkSelections[currentTab].clear(); updateNetworkSelection(); };
$('delete-selected-devices').onclick = () => {
  const selected = tabDevices().filter(row => networkSelections[currentTab].has(row.id));
  if (!selected.length) return;
  batchDeletingIds = selected.map(row => row.id);
  const hiddenCount = selected.filter(row => !visibleDevices.some(visible => visible.id === row.id)).length;
  const type = currentTab === 'iptv' ? 'channel' : 'device';
  $('batch-delete-title').textContent = `Delete ${selected.length} ${type}${selected.length === 1 ? '' : 's'}?`;
  $('batch-delete-description').textContent = `This permanently removes the selected records from the shared inventory.${hiddenCount ? ` ${hiddenCount} selected ${hiddenCount === 1 ? 'record is' : 'records are'} outside the current filters.` : ''}`;
  $('batch-delete-list').replaceChildren(...selected.map(row => element('li', '', [deviceLabel(row), row.venue, row.ip].filter(Boolean).join(' · '))));
  $('confirm-batch-delete').textContent = `Delete ${selected.length} ${type}${selected.length === 1 ? '' : 's'}`;
  $('batch-delete-error').hidden = true;
  $('batch-delete-dialog').showModal(); $('cancel-batch-delete').focus();
};
$('cancel-batch-delete').onclick = () => $('batch-delete-dialog').close();
$('confirm-batch-delete').onclick = async () => {
  const ids = [...batchDeletingIds];
  $('confirm-batch-delete').disabled = true;
  $('cancel-batch-delete').disabled = true;
  try {
    await Promise.allSettled([...pendingNoteSaves.values(), ...pendingWrites]);
    const result = await api('/api/devices/batch-delete', 'POST', {ids});
    for (const selected of Object.values(networkSelections)) ids.forEach(id => selected.delete(id));
    $('batch-delete-dialog').close(); toast(`${result.deleted} ${result.deleted === 1 ? 'record' : 'records'} deleted.`); await load();
  } catch(error) { $('batch-delete-error').textContent = error.message; $('batch-delete-error').hidden = false; }
  finally { $('confirm-batch-delete').disabled = false; $('cancel-batch-delete').disabled = false; }
};
$('batch-delete-dialog').addEventListener('cancel', event => {
  if ($('confirm-batch-delete').disabled) event.preventDefault();
});
document.querySelectorAll('.export-dropdown').forEach(menu => {
  menu.addEventListener('toggle', () => {
    if (menu.open) document.querySelectorAll('.export-dropdown').forEach(other => { if (other !== menu) other.open = false; });
  });
  menu.addEventListener('click', event => {
    if (event.target.closest('a[download]')) { menu.open = false; menu.querySelector('summary').focus(); }
  });
});
document.addEventListener('pointerdown', event => {
  if (!event.target.closest('.export-dropdown')) closeExportMenus();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.querySelector('.export-dropdown[open]')) {
    event.preventDefault(); closeExportMenus(true);
  }
});
document.querySelectorAll('.export-links a[download]').forEach(link => {
  link.addEventListener('click', async event => {
    event.preventDefault();
    if (link.getAttribute('aria-disabled') === 'true') return;
    link.setAttribute('aria-disabled', 'true');
    try {
      const equipment = link.closest('#equipment-panel') !== null;
      const exportInventory = equipment ? window.equipmentUI.currentInventory() : null;
      const recordType = currentTab;
      const scope = $(equipment ? 'equipment-export-scope' : 'network-export-scope').value;
      let exportRows = scope === 'selected' ? visibleDevices.filter(row => networkSelections[currentTab]?.has(row.id)) : visibleDevices;
      if (!equipment && scope === 'selected' && $('sort-order').value) exportRows.sort((a,b) => compareDirectoryRecords(a,b,$('sort-order').value));
      // A download immediately after a note edit must include that saved note.
      if (document.activeElement?.matches('.device-notes-editor')) document.activeElement.blur();
      await Promise.all([...pendingNoteSaves.values(), ...pendingWrites]);
      if (equipment) await window.equipmentUI.flush();
      if (equipment && window.equipmentUI.currentInventory().id !== exportInventory.id) throw new Error('The inventory changed. Choose the export again.');
      const equipmentExport = equipment ? window.equipmentUI.exportData(scope) : null;
      const ids = equipment ? equipmentExport.ids : exportRows.map(row => row.id);
      const payload = equipment ? {ids, inventory_id:equipmentExport.inventory_id} : {record_type:recordType, ...(scope === 'all' ? {} : {ids})};
      const exportURL = new URL(link.href);
      if (equipment && scope === 'all') exportURL.searchParams.set('inventory_id', equipmentExport.inventory_id);
      const response = await fetch(exportURL, equipment && scope === 'all' ? {} : {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)
      });
      if (!response.ok) throw new Error((await response.json()).error || 'Could not export inventory.');
      const url = URL.createObjectURL(await response.blob());
      const download = element('a'); download.href = url;
      const extension = new URL(link.href).pathname.split('.').pop();
      let inventoryFilename = equipment ? equipmentExport.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'equipment' : '';
      if (equipment && equipmentExport.inventory_id === 1 && equipmentExport.name === 'Equipment inventory') inventoryFilename = 'equipment';
      download.download = `broadcasthub-${equipment ? inventoryFilename : recordType === 'iptv' ? 'iptv-channels' : 'av-devices'}.${['csv','xlsx','pdf'].includes(extension) ? extension : 'json'}`;
      document.body.append(download); download.click(); download.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch(error) { toast('Export failed: ' + error.message); }
    finally { link.removeAttribute('aria-disabled'); }
  });
});
function options(id, values) {
  const select = $(id), previous = select.value;
  while (select.options.length > 1) select.remove(1);
  [...new Set(values.filter(v => v !== null && v !== undefined && v !== ''))].sort((a,b) => typeof a === 'number' ? a-b : a.localeCompare(b)).forEach(value => select.add(new Option(value, value)));
  if ([...select.options].some(option => option.value === previous)) select.value = previous;
}
async function load() {
  if (currentTab === 'equipment') return window.equipmentUI.load();
  $('refresh').disabled = true;
  try {
    await satelliteCatalogReady;
    devices = (await api('/api/devices')).devices;
    networkLoaded = true;
    $('load-error').hidden = true;
    updateFilterOptions();
    $('venues').replaceChildren(...savedVenues().map(v => new Option(v, v)));
    render();
    await loadOverview();
    return true;
  } catch (error) {
    $('load-error').textContent = 'Could not refresh inventory. ' + error.message;
    $('load-error').hidden = false;
    return false;
  } finally { $('loading').hidden = true; $('refresh').disabled = false; }
}
function udpCell(device) {
  const cell = element('div', 'udp-cell');
  const field = element('div', 'udp-field');
  const input = element('input', 'udp-address');
  input.type = 'text'; input.readOnly = true; input.spellcheck = false;
  input.value = device.ip && !isDHCP(device.ip) && device.port ? `udp://@${device.ip}:${device.port}` : '';
  input.setAttribute('aria-label', `UDP address for ${deviceLabel(device)}`);
  input.onfocus = () => input.select();
  input.onclick = input.ondblclick = () => requestAnimationFrame(() => input.select());
  const copy = element('button', 'quiet udp-copy');
  copy.type = 'button'; copy.disabled = !input.value;
  copy.setAttribute('aria-label', `Copy UDP address for ${deviceLabel(device)}`);
  copy.title = 'Copy UDP address';
  copy.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(input.value);
      toast('UDP address copied.');
    } catch {
      input.focus(); input.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch {}
      toast(copied ? 'UDP address copied.' : 'UDP address selected. Copy it using your browser’s menu.');
    }
  };
  field.append(input, copy); cell.append(field); return cell;
}
function ipCopyButton(device, addressText) {
  const button = element('button', 'ip-copy'); button.type = 'button';
  button.title = 'Copy IP address';
  button.setAttribute('aria-label', `Copy IP address for ${deviceLabel(device)}`);
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0 2 2h2"/></svg>';
  button.onclick = async () => {
    let copied = false;
    try { await navigator.clipboard.writeText(device.ip); copied = true; } catch {}
    if (!copied) {
      const buffer = element('textarea', 'clipboard-copy-buffer');
      buffer.value = device.ip; buffer.readOnly = true;
      const previousFocus = document.activeElement;
      document.body.append(buffer);
      try {
        buffer.focus({preventScroll:true}); buffer.select();
        copied = document.execCommand('copy');
      } catch {} finally { buffer.remove(); previousFocus?.focus({preventScroll:true}); }
    }
    if (copied) toast('IP address copied.');
    else {
      const range = document.createRange(); range.selectNodeContents(addressText);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      toast('IP address selected. Use your browser’s Copy option.');
    }
  };
  return button;
}
function render() {
  if (currentTab === 'equipment') return;
  closeSystemMenu();
  const iptvDirectory = currentTab === 'iptv';
  $('device-directory').classList.toggle('iptv-directory', iptvDirectory);
  $('directory-venue-title').hidden = iptvDirectory;
  $('directory-vlan-title').hidden = iptvDirectory;
  $('directory-udp-title').hidden = !iptvDirectory;
  $('directory-device-title').textContent = iptvDirectory ? 'CHANNEL' : 'DEVICE';
  $('directory-system-title').textContent = iptvDirectory ? 'SOURCE' : 'SYSTEM';
  $('venue-filter').classList.remove('venue-choice');
  $('venue-filter').style.removeProperty('--venue-color');
  colorVenueButton($('venue-filter'), $('venue-filter').value);
  syncButtons('system-buttons', $('system-filter').value);
  syncButtons('source-buttons', $('source-filter').value);
  syncButtons('address-buttons', $('address-filter').value);
  updatePageSummary();
  const current = tabDevices();
  const selected = networkSelections[currentTab];
  const hasDHCP = currentTab === 'device' && current.some(d => isDHCP(d.ip));
  $('address-filter-group').hidden = !hasDHCP;
  if (!hasDHCP) $('address-filter').value = '';
  $('total').textContent = current.length;
  $('venue-count').textContent = savedVenues().length;
  $('vlan-count').textContent = new Set(current.map(d => d.vlan).filter(v => v !== null)).size;
  $('system-count').textContent = (currentTab === 'iptv' ? ['Onboard','Satellite'].map(source => current.filter(d => d.channel_source === source).length) : ['Video','Audio','Lighting'].map(system => current.filter(d => d.discipline === system).length)).join(' / ');
  const query = $('search').value.trim().toLowerCase();
  const results = current.filter(d =>
    [d.name,d.ip,d.venue,d.category,d.discipline,d.notes,d.channel_source || '',String(d.vlan || ''), String(d.port || '')].some(v => v.toLowerCase().includes(query)) &&
    (!$('venue-filter').value || cleanVenue(d.venue) === $('venue-filter').value) &&
    (!$('system-filter').value || d.discipline === $('system-filter').value) &&
    (!$('source-filter').value || d.channel_source === $('source-filter').value) &&
    (!$('address-filter').value || isDHCP(d.ip)));
  if ($('sort-order').value) results.sort((a, b) => compareDirectoryRecords(a, b, $('sort-order').value));
  visibleDevices = results;
  const visibleIds = new Set(results.map(row => row.id));
  for (const id of selected) if (!visibleIds.has(id)) selected.delete(id);
  $('result-count').textContent = results.length;
  $('showing').textContent = `${results.length} of ${current.length} ${currentTab === 'iptv' ? 'channels' : 'devices'}`;
  $('empty').hidden = current.length > 0;
  $('no-results').hidden = current.length === 0 || results.length > 0;
  const rows = results.map(device => {
    const row = element('article', 'device-row');
    const identity = element('div', 'device-identity identity-cell');
    identity.append(selectionControl(device.id, deviceLabel(device), selected, () => {
      if (selected.size) $('network-export-scope').value = 'selected';
      updateNetworkSelection();
    }));
    const title = element('div');
    const name = element('div', 'device-name');
    const channel = device.record_type === 'iptv' ? satelliteChannelForName(device.name) : null;
    if (channel?.logo) {
      name.classList.add('channel-name');
      const logo = element('img', 'channel-logo');
      logo.src = channel.logo; logo.alt = ''; logo.loading = 'lazy';
      logo.onerror = () => logo.remove();
      name.append(element('span', '', device.name), logo);
    } else name.textContent = device.name;
    title.append(name, element('span', 'device-category', device.category));
    const notes = element('textarea', 'device-notes-editor');
    notes.rows = 1; notes.maxLength = 2000; notes.value = device.notes;
    notes.dataset.deviceId = device.id;
    notes.setAttribute('aria-label', `Notes for ${deviceLabel(device)}`);
    notes.title = 'Notes save when you leave this field.';
    notes.onchange = async () => {
      const draft = notes.value;
      const previous = devices.find(row => row.id === device.id)?.notes || '';
      devices = devices.map(row => row.id === device.id ? {...row,notes:draft} : row);
      try {
        const updated = await saveNotes(device.id, draft);
        // Keep the current field and focus; update only notes in case another edit ran too.
        devices = devices.map(row => row.id === updated.id && row.notes === draft ? {...row,notes:updated.notes} : row);
        const currentField = document.querySelector(`.device-notes-editor[data-device-id="${device.id}"]`);
        if (currentField?.value === draft) currentField.value = updated.notes;
      } catch(error) {
        devices = devices.map(row => row.id === device.id && row.notes === draft ? {...row,notes:previous} : row);
        toast('Could not save notes: ' + error.message);
      }
    };
    const notesCell = element('div', 'notes-cell');
    notesCell.append(notes);
    identity.append(title);
    const ip = element('div', 'ip-cell');
    const iptv = device.record_type === 'iptv';
    if (iptv) row.classList.add('iptv-row');
    const ipLine = element('div', 'ip-info-line');
    const address = element('div', 'ip-address-value');
    const addressText = element('div', 'device-ip', device.ip);
    address.append(addressText);
    if (device.ip && !isDHCP(device.ip)) address.append(ipCopyButton(device, addressText));
    ipLine.append(address);
    ip.append(ipLine, element('span', 'cell-caption', iptv ? (device.port ? `Port ${device.port}` : '') : ''));
    const confirmation = element('button', `ip-confirm ${device.ip_confirmed ? 'confirmed' : 'pending'}`, device.ip_confirmed ? '✓ IP confirmed' : '● Confirm IP');
    confirmation.type = 'button';
    confirmation.disabled = Boolean(device.ip_confirmed);
    confirmation.setAttribute('aria-label', `${device.ip_confirmed ? 'IP confirmed for' : 'Confirm IP for'} ${deviceLabel(device)}`);
    confirmation.title = device.ip_confirmed ? 'Network reachability confirmed by you.' : 'Click after verifying that this device is reachable on the network.';
    confirmation.onclick = async () => {
      confirmation.disabled = true;
      try {
        const updated = await api(`/api/devices/${device.id}/confirm`, 'POST', {ip:device.ip, vlan:device.vlan});
        devices = devices.map(row => row.id === updated.id ? {...row,ip_confirmed:updated.ip_confirmed} : row);
        render(); toast('IP assignment confirmed.'); await loadOverview();
      } catch(error) { confirmation.disabled = false; toast('Confirmation failed: ' + error.message); }
    };
    if (!iptv && device.ip && !isDHCP(device.ip)) ipLine.append(confirmation);
    const venue = element('div', 'venue-cell');
    const venueName = cleanVenue(device.venue);
    const venueLabel = element(venueName ? 'button' : 'div', 'device-venue', venueName);
    if (venueName) {
      venueLabel.type = 'button'; venueLabel.classList.add('choice-button');
      colorVenueButton(venueLabel, venueName);
      venueLabel.setAttribute('aria-label', `Filter venue ${venueName}`);
      venueLabel.onclick = () => { $('venue-filter').value = venueName; render(); };
    }
    venue.append(venueLabel);
    const system = element('div','system-cell');
    if (iptv) {
      if (device.channel_source) system.append(element('span', `badge ${device.discipline.toLowerCase()}`, device.channel_source));
    } else {
      system.append(systemDropdown(device));
    }
    const actions = element('div', 'row-actions');
    const edit = element('button', 'quiet', 'Edit'); edit.setAttribute('aria-label', `Edit ${deviceLabel(device)}`); edit.onclick = () => openForm(device);
    const remove = element('button', 'quiet', 'Delete'); remove.setAttribute('aria-label', `Delete ${deviceLabel(device)}`);
    remove.onclick = () => { deleting = device; $('delete-description').textContent = `${device.name} · ${device.ip} · ${iptv ? 'Port ' + (device.port || 'not set') : 'VLAN ' + device.vlan}`; $('delete-error').hidden = true; $('delete-dialog').showModal(); $('cancel-delete').focus(); };
    actions.append(edit,remove);
    row.append(identity);
    if (!iptv) row.append(venue);
    row.append(ip);
    if (iptv) row.append(udpCell(device));
    if (!iptv) row.append(element('div', 'vlan-cell', device.vlan ?? ''));
    row.append(system,notesCell,actions); return row;
  });
  $('device-list').replaceChildren(...rows);
  updateNetworkSelection();
  renderImportWarnings();
}
function renderImportWarnings() {
  const duplicates = new Map();
  devices.filter(d => (d.record_type || 'device') === 'device' && d.ip && !isDHCP(d.ip)).forEach(d => {
    if (!duplicates.has(d.ip)) duplicates.set(d.ip, []);
    duplicates.get(d.ip).push(d.name);
  });
  const warnings = [...importWarnings, ...[...duplicates].filter(([, names]) => names.length > 1).map(([ip, names]) => `Duplicate IP ${ip} in existing inventory: ${names.join(', ')}. Edit or remove the repeated assignments.`)];
  $('import-warnings').hidden = currentTab !== 'device' || !warnings.length;
  $('import-warning-list').replaceChildren(...warnings.map(message => element('li', '', message)));
}
function openForm(device = null) {
  if (device?.id) device = devices.find(row => row.id === device.id) || device;
  editing = device?.id ?? null;
  form.reset(); $('form-error').hidden = true;
  const iptv = currentTab === 'iptv';
  form.elements.record_type.value = currentTab;
  $('category-field').hidden = iptv;
  $('form-system-group').hidden = iptv;
  $('form-source-group').hidden = !iptv;
  $('venue-field').hidden = $('vlan-field').hidden = iptv;
  form.elements.venue.disabled = form.elements.vlan.disabled = iptv;
  $('port-field').hidden = !iptv;
  form.elements.port.required = false; form.elements.port.disabled = !iptv;
  $('name-label').textContent = iptv ? 'Channel name' : 'Device name';
  $('form-intro').textContent = iptv ? 'Track the channel’s stream address, port, and source.' : 'Give this device a home in your inventory.';
  form.elements.name.placeholder = iptv ? 'e.g. Ship information or BBC News' : 'e.g. ATEM video switcher';
  form.elements.ip.placeholder = iptv ? 'e.g. 239.1.1.10' : '10.24.176.66 or DHCP';
  $('ip-hint').textContent = iptv ? 'IPv4 unicast or multicast' : 'IPv4 or DHCP · checked when saved';
  $('form-title').textContent = editing ? (iptv ? 'Edit channel' : 'Edit device') : (iptv ? 'Add channel' : 'Add device');
  $('save-device').textContent = editing ? 'Save changes' : (iptv ? 'Save channel' : 'Save device');
  if (device) for (const field of ['name','category','venue','discipline','ip','vlan','notes','channel_source','port']) form.elements[field].value = device[field] ?? '';
  syncButtons('form-source-buttons', form.elements.channel_source.value);
  form.elements.venue.value = cleanVenue(form.elements.venue.value);
  const venues = savedVenues();
  $('venue-suggestions').hidden = iptv || !venues.length;
  makeButtons('form-venue-buttons', venues, form.elements.venue.value, value => { form.elements.venue.value = value; syncButtons('form-venue-buttons', value); });
  $('device-dialog').showModal();
}
form.elements.venue.addEventListener('input', () => syncButtons('form-venue-buttons', form.elements.venue.value));
$('add-device').onclick = () => currentTab === 'equipment' ? window.equipmentUI.open() : openForm();
$('empty-add').onclick = () => openForm();
$('use-example').onclick = () => openForm({name:'ATEM video switcher', category:'Video switcher', venue:'Liquid Lounge', discipline:'Video', ip:'10.24.176.66', vlan:1500, notes:''});
for (const id of ['close-dialog','cancel-dialog']) $(id).onclick = () => $('device-dialog').close();
for (const id of filters) $(id).addEventListener(id === 'search' ? 'input' : 'change', render);
$('sort-order').onchange = () => { tabSortOrders[currentTab] = $('sort-order').value; render(); };
$('clear-filters').onclick = () => { filters.forEach(id => $(id).value = ''); render(); };
$('refresh').onclick = load;
form.onsubmit = async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  $('save-device').disabled = true; $('form-error').hidden = true;
  try {
    // Finish any inline note save before submitting newer changes from Edit.
    if (editing && pendingNoteSaves.has(editing)) await pendingNoteSaves.get(editing).catch(() => {});
    await api(editing ? `/api/devices/${editing}` : '/api/devices', editing ? 'PUT' : 'POST', data);
    $('device-dialog').close();
    toast(editing ? 'Record updated.' : currentTab === 'iptv' ? 'Channel added to IPTV inventory.' : 'Device added to inventory.');
    await load();
  } catch (error) { $('form-error').textContent = error.message; $('form-error').hidden = false; }
  finally { $('save-device').disabled = false; }
};
$('cancel-delete').onclick = () => $('delete-dialog').close();
$('confirm-delete').onclick = async () => {
  $('confirm-delete').disabled = true;
  try { await api(`/api/devices/${deleting.id}`, 'DELETE', {}); $('delete-dialog').close(); toast('Device deleted.'); await load(); }
  catch(error) { $('delete-error').textContent = error.message; $('delete-error').hidden = false; }
  finally { $('confirm-delete').disabled = false; }
};
let spreadsheetFile = null, spreadsheetData = null;
let spreadsheetInventory = null;
let spreadsheetReviewing = false, stopSpreadsheetReview = false;
let venueEdits = new Map();
const networkImportFields = [
  ['venue', 'Venue', ['venue','location','venue location','room','area']],
  ['name', 'Device name', ['device name','name','device','equipment','equipment name','hostname','channel','channel name']],
  ['ip', 'IP address', ['ip address','ip adress','ip','ipaddress','ipadress','ipv4','ipv4 address']],
  ['vlan', 'VLAN (optional)', ['vlan','vlan id','vlan number']],
  ['category', 'Category', ['category','device category','device type','type','model']],
  ['discipline', 'System', ['discipline','system','department','av system','function']],
  ['notes', 'Notes (optional)', ['notes','note','comments','description']],
  ['record_type', 'Inventory type', ['record type','inventory type']],
  ['channel_source', 'Channel source (IPTV)', ['channel source','source','onboard or satellite']],
  ['port', 'Port (IPTV)', ['port','udp port','stream port','port number']]
];
const equipmentCheckFields = ['description','brand','model','serial_number','quantity','location'];
function equipmentIssues(row) {
  const profile=window.equipmentUI?.profile() || defaultInventoryLayout;
  const important=profile.columns.filter(col=>col.important&&col.key!=='orientation');
  const issues=[...(row.source_issues || []),...important.filter(col=>String(inventoryValue(row,col.key)).trim()==='').map(col=>`Missing ${col.label}`)];

  profile.columns.filter(col=>['select','buttons'].includes(col.type)).forEach(col=>{const value=String(inventoryValue(row,col.key));if(value&&!col.options.some(option=>option.toLowerCase()===value.toLowerCase()))issues.push(`Check ${col.label}: ${value}`);});
  profile.columns.filter(col=>col.type==='count').forEach(col=>{const value=String(inventoryValue(row,col.key)).trim();if(value&&(!/^\d+$/.test(value)||Number(value)<(col.minimum ?? 1)||Number(value)>50))issues.push(`Check ${col.label}: choose ${(col.minimum ?? 1)}–50`);});
  if (/[|;,\n]/.test(row.serial_number || '')) issues.push('Multiple serial numbers in one record');
  if (/separate inventory|not an itemized|reference to/i.test(row.notes || '')) issues.push('Inventory reference: check itemized source');
  return issues;
}
function orderEquipmentReview(entries) {
  const serialCounts = new Map();
  const profile=window.equipmentUI?.profile()||defaultInventoryLayout;const identifierCounts=new Map();
  const rowIdentifier=row=>profile.stock_mode==='tv_counts'&&row.brand&&row.model?JSON.stringify([row.brand.trim().toLowerCase(),row.model.trim().toLowerCase()]):profile.identifier?String(inventoryValue(row,profile.identifier)).trim().toLowerCase():'';
  entries.forEach(({row}) => { const key = (row.serial_number || '').trim().toLowerCase(); if (key) serialCounts.set(key, (serialCounts.get(key) || 0) + 1); });
  entries.forEach(({row})=>{const value=rowIdentifier(row);if(value)identifierCounts.set(value,(identifierCounts.get(value)||0)+1);});
  const groups = new Map();
  entries.forEach(entry => {
    entry.issues = equipmentIssues(entry.row);
    if(identifierCounts.get(rowIdentifier(entry.row))>1)entry.issues.push('Repeated item identifier in this file');
    if (serialCounts.get((entry.row.serial_number || '').trim().toLowerCase()) > 1) entry.issues.push('Repeated serial number in this file');
    const location = entry.row.location || '';
    if (!groups.has(location)) groups.set(location, []);
    groups.get(location).push(entry);
  });
  const ordered = [];
  [...groups].filter(([location]) => location).concat([...groups].filter(([location]) => !location)).forEach(([location, rows], groupIndex) => {
    rows.sort((a,b) => Boolean(a.issues.length) - Boolean(b.issues.length));
    rows.forEach((entry,index) => { entry.locationProgress = `${location || 'Unassigned location'} · Location ${groupIndex + 1} of ${groups.size} · Item ${index + 1} of ${rows.length} · ${entry.issues.length ? 'Flagged rows' : 'Complete rows'}`; ordered.push(entry); });
  });
  return ordered;
}
const equipmentImportFields = [
  ['description','Item',['item','description','equipment','item name','item description']],
  ['brand','Brand',['brand','manufacturer','make']],
  ['model','Model',['model','model number','part number']],
  ['serial_number','Serial number (optional)',['serial number','serial','serial no','s/n','sn']],
  ['quantity','Quantity',['quantity','qty','count','stock','quantity in stock']],
  ['location','Location',['location','venue','room','storage','storage location']],
  ['item_confirmed','Status (optional)',['item confirmed','located','found','confirmed','confirmation']],
  ['notes','Notes (optional)',['notes','note','comments']]
];
const iptvImportFields = [
  ['name', 'Channel Name', ['channel name','channel','name']],
  ['ip', 'Multicast IP', ['mcast ip [s]','mcast ip','multicast ip','ip address','ip adress','ip','ipv4']],
  ['port', 'Port', ['mcast port [s]','mcast port','multicast port','port','udp port','stream port','port number']],
  ['notes', 'Notes (optional)', ['notes','note','comments','description']]
];
const normalizedChannelName = name => name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const satelliteChannelAliases = new Map();
let satelliteCatalogError = null;
const satelliteCatalogReady = api('/satellite-channels.json').then(catalog => {
  if (catalog.version !== 1 || !Array.isArray(catalog.channels)) throw new Error('Invalid satellite channel reference.');
  for (const channel of catalog.channels) {
    for (const alias of [channel.name, ...channel.aliases]) satelliteChannelAliases.set(normalizedChannelName(alias), channel);
  }
}).catch(error => { satelliteCatalogError = error; });
function satelliteChannelForName(name) {
  const channel = normalizedChannelName(name).replace(/(?:\s+(?:hd|sd|fhd|uhd|4k|1080p|720p))+$/, '');
  return satelliteChannelAliases.get(channel);
}
function channelSourceFromName(name) {
  const text = name.toLowerCase().replace(/\s+/g, ' ');
  if (['cltv','carnival','map','crew','scala','casino','safety'].some(keyword => text.includes(keyword))) return 'Onboard';
  if (satelliteChannelForName(name)) return 'Satellite';
  return '';
}
function channelCodecIPs(rows) {
  return new Set(rows.filter(row => row.record_type === 'iptv' && Number(row.port) === 2000 && importAddressKey(row)).map(row => row.ip.trim()));
}
function channelNotesWithCodec(row, codecIPs) {
  const notes = row.notes || '';
  const codec = Number(row.port) === 2000 ? 'H.264'
    : Number(row.port) === 1234 && importAddressKey(row) && codecIPs.has(row.ip.trim()) ? 'H.265' : '';
  if (!codec || new RegExp(`\\b${codec.replace('.', '\\.')}\\b`, 'i').test(notes)) return notes;
  return notes ? `${notes} · ${codec}` : codec;
}
const customImportFields=()=> (spreadsheetInventory?.layout || window.equipmentUI?.profile() || defaultInventoryLayout).columns.filter(col=>col.type!=='calculated').map(col=>{const existing=equipmentImportFields.find(([key])=>key===col.key);return [col.key,col.label,[normalizedHeader(col.label),col.key.replaceAll('_',' '),...(col.aliases || []).map(normalizedHeader),...(existing?.[2] || [])]];});
const importFields = () => currentTab === 'equipment' ? customImportFields() : currentTab === 'device'
  ? networkImportFields.filter(([field]) => ['venue','name','ip','vlan','notes'].includes(field))
  : iptvImportFields;
const normalizedHeader = value => value.toLowerCase().replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim();
function mappedRows(applyVenueEdits = true) {
  return spreadsheetData.rows.map(row => {
    const mapped = Object.fromEntries(importFields().map(([field]) => {
      const column = $('map-' + field).value;
      let value = column === '' ? '' : row[Number(column)];
      if (field === 'record_type') value = value.toLowerCase() || currentTab;
      if (field === 'ip' && isDHCP(value)) value = 'DHCP';
      if (field === 'venue' || field === 'location') value = cleanVenue(value);
      if (field === 'vlan' && !/^[0-9]+$/.test(value)) value = '';
      if (field === 'channel_source') value = ({onboard:'Onboard', satellite:'Satellite'})[value.toLowerCase()] || value;
      if (field === 'discipline') {
        const aliases = {video:'Video', audio:'Audio', lighting:'Lighting', lights:'Lighting', light:'Lighting', control:'Control', network:'Network', other:'Other'};
        value = aliases[value.toLowerCase()] || value;
      }
      return [field, value];
    }));
    if (currentTab === 'equipment') {
      const values={};
      Object.keys(mapped).forEach(key=>{if(!inventoryBaseFields.has(key)){values[key]=mapped[key];delete mapped[key];}});
      mapped.custom_values=values;
      inventoryBaseFields.forEach(key=>{if(mapped[key]==null)mapped[key]='';});
      const extras = ['name','storage_position','condition','unit','quantity_original','source_sheet','source_row'];
      const read = name => { const index = spreadsheetData.headers.findIndex(header => header.trim().toLowerCase() === name); return index < 0 ? '' : String(row[index] ?? '').trim(); };
      if (!mapped.description && importFields().some(([key])=>key==='description') && $('map-description').value!=='') mapped.description = read('name');
      const hasMapped=Object.entries(mapped).some(([key,value])=>key==='custom_values'?Object.values(value).some(v=>String(v).trim()):String(value??'').trim());
      const details = extras.filter(name => hasMapped && name !== 'name' && read(name)).map(name => `${name.replaceAll('_',' ')}: ${read(name)}`);
      mapped.notes = [mapped.notes, ...details].filter(Boolean).join(' · ');
      mapped.item_confirmed = ''; // Old files do not establish a new physical location check.
    }
    if (currentTab !== 'equipment') mapped.record_type = currentTab;
    if (currentTab === 'iptv') mapped.channel_source = channelSourceFromName(mapped.name);
    const field = currentTab === 'equipment' ? 'location' : 'venue';
    if (applyVenueEdits && venueEdits.has(mapped[field])) mapped[field] = venueEdits.get(mapped[field]);
    if(currentTab==='equipment'){const profile=spreadsheetInventory?.layout || window.equipmentUI.profile();const calculated=inventoryCalculate(mapped,profile);calculated.source_issues=[];profile.columns.filter(col=>col.type==='calculated').forEach(col=>{const aliases=[col.label,...(col.aliases || [])].map(normalizedHeader);const index=spreadsheetData.headers.findIndex(header=>aliases.includes(normalizedHeader(header)));const original=index>=0?String(row[index] || '').trim():'';if(original!==''&&String(inventoryValue(calculated,col.key))!==original)calculated.source_issues.push(`Original ${col.label}: ${original}; calculated: ${inventoryValue(calculated,col.key) || 'unknown'}`);});return calculated;}return mapped;
  });
}
function showVenueEditors() {
  const equipment = currentTab === 'equipment', field = equipment ? 'location' : 'venue';
  if(equipment && !(spreadsheetInventory?.layout || window.equipmentUI.profile()).columns.some(col=>col.key==='location'&&col.filter==='buttons')){$('import-venue-editor').hidden=true;return;}
  const venues = [...new Set(mappedRows(false).filter(row => equipment || row.record_type !== 'iptv').map(row => row[field]).filter(Boolean))];
  $('import-venue-editor').hidden = !venues.length;
  $('import-venue-title').textContent = equipment ? 'Location buttons' : 'Venue buttons';
  $('import-venue-list').replaceChildren(...venues.map((original, index) => {
    const row = element('div', 'venue-editor-row');
    const button = element('button', 'choice-button', venueEdits.has(original) ? venueEdits.get(original) : original);
    button.type = 'button';
    colorVenueButton(button, button.textContent);
    const label = element('label');
    label.append(element('span', 'sr-only', `Edit ${equipment ? 'location' : 'venue'} ${original}`));
    const input = element('input');
    input.id = `import-venue-${index}`; input.value = button.textContent; input.maxLength = 120;
    input.autocomplete = 'off';
    input.oninput = () => {
      const venue = cleanVenue(input.value);
      venueEdits.set(original, venue);
      button.textContent = venue;
      colorVenueButton(button, venue);
      showSpreadsheetPreview();
    };
    input.onblur = () => { input.value = cleanVenue(input.value); };
    button.onclick = () => { input.focus(); input.select(); };
    label.append(input); row.append(button, label); return row;
  }));
}
function showSpreadsheetPreview() {
  $('equipment-import-audit').hidden = currentTab !== 'equipment';
  if (currentTab === 'equipment') {
    const entries = orderEquipmentReview(mappedRows().map((row,index) => ({row,number:spreadsheetData.row_numbers[index]})).filter(({row}) => meaningfulImportRow(row)));
    const profile=spreadsheetInventory.layout || defaultInventoryLayout;
    $('equipment-import-audit').textContent = `${profile.stock_mode==='tv_counts'?entries.filter(entry=>entry.row.quantity===0).length+' zero-stock rows will be skipped':profile.location_role==='geographic'?entries.length+' device locations':new Set(entries.map(entry => entry.row.location)).size+' storage locations'} · ${entries.filter(entry => entry.issues.length).length} flagged rows. For each location, complete rows come first, then flagged rows. Storage position, condition, unit and source details are kept in Notes. This import starts with locations unconfirmed.`;
  }
  const rows = mappedRows();
  if (currentTab === 'iptv') {
    const codecIPs = channelCodecIPs([...devices, ...rows]);
    rows.forEach(row => { row.notes = channelNotesWithCodec(row, codecIPs); });
  }
  $('spreadsheet-preview').replaceChildren(...rows.slice(0,3).map((row, index) => {
    const card = element('div', 'spreadsheet-preview-row');
    if (currentTab === 'equipment') {
      card.append(element('strong','',`Row ${spreadsheetData.row_numbers[index]}`));
      const profile=spreadsheetInventory?.layout || window.equipmentUI.profile();
      card.append(element('p','',profile.columns.map(col=>`${col.label}: ${inventoryValue(row,col.key) || 'Blank'}`).join(' · ')));return card;
    }
    card.append(element('strong', '', `Row ${spreadsheetData.row_numbers[index]} · ${row.name}`));
    card.append(element('p', '', (row.record_type === 'iptv' ? [row.ip, row.port ? `Port ${row.port}` : '', row.channel_source] : [row.ip, row.vlan ? `VLAN ${row.vlan}` : '', row.venue]).filter(Boolean).join(' · ')));
    card.append(element('p', '', [row.discipline, row.category].filter(Boolean).join(' / ')));
    if (row.notes) card.append(element('p', '', row.notes));
    return card;
  }));
}
async function loadSpreadsheet() {
  $('confirm-import').disabled = true; $('reload-sheet').disabled = true;
  $('spreadsheet-error').hidden = true;
  try {
    const workbook=/\.xlsx$/i.test(spreadsheetFile.filename);
    $('sheet-label').hidden=!workbook;
    $('worksheet-note').hidden=workbook;
    if(workbook && ![...$('sheet-choice').options].some(option=>option.value)) {
      $('sheet-choice').disabled=true;
      $('sheet-choice').replaceChildren(new Option('Loading worksheets…',''));
      const catalog=await api('/api/spreadsheet-preview','POST',{...spreadsheetFile,sheets_only:true});
      if(!catalog.sheets?.length)throw new Error('This workbook has no worksheets.');
      $('sheet-choice').replaceChildren(...catalog.sheets.map(sheet=>new Option(sheet,sheet)));
      $('sheet-choice').disabled=false;
    }
    if (currentTab === 'iptv') {
      await satelliteCatalogReady;
      if (satelliteCatalogError) throw new Error('Could not load the satellite channel reference. Refresh the page and try again.');
    }
    const data = await api('/api/spreadsheet-preview', 'POST', {...spreadsheetFile, sheet: $('sheet-choice').value, header_row: Number($('header-row').value),keep_headers:currentTab==='equipment'?customImportFields().flatMap(([key,label,aliases])=>[label,...aliases]):[]});
    spreadsheetData = data;
    venueEdits = new Map();
    $('sheet-label').hidden = !data.sheets.length;
    $('sheet-choice').replaceChildren(...data.sheets.map(sheet => new Option(sheet, sheet)));
    $('sheet-choice').value = data.sheet;
    if(currentTab==='equipment')$('spreadsheet-title').textContent='Step 2: match file columns to your inventory';else $('spreadsheet-title').textContent='Match your columns';
    $('import-complete-options').hidden=currentTab!=='equipment';
    $('spreadsheet-review-help').textContent=currentTab==='equipment' ? 'Match each inventory field to a file column. Complete matched rows can be added automatically. Review remaining rows together, grouped by location; edit their cells and import or skip selected rows. Calculated totals need no file column. Zero-stock TV rows are skipped. Orientation is optional.' : 'Match each field to a column, or choose Leave blank. Missing columns and empty cells stay blank. Click Review rows, then choose Yes or Skip for each row.';
    $('spreadsheet-summary').textContent = `${spreadsheetFile.filename} · ${data.rows.length} records${spreadsheetInventory ? ' · Inventory: ' + spreadsheetInventory.name : ''}`;
    if (data.ignored_columns?.length) $('spreadsheet-summary').textContent += ` · Ignored columns: ${data.ignored_columns.join(', ')}`;
    $('column-mappings').replaceChildren(...importFields().map(([field, label, aliases]) => {
      const group = element('div', 'mapping-row');
      const columnLabel = element('label', '', label);
      const select = element('select'); select.id = 'map-' + field;
      select.add(new Option('Leave blank', ''));
      data.headers.forEach((header, index) => select.add(new Option(`${index+1}. ${header}`, String(index))));
      // Prefer the requested header before falling back to broader aliases.
      const matched = aliases.map(alias => data.headers.findIndex(header => normalizedHeader(header) === alias)).find(index => index >= 0) ?? -1;
      if (matched >= 0) select.value = String(matched);
      columnLabel.append(select); group.append(columnLabel);
      select.onchange = () => { showVenueEditors(); showSpreadsheetPreview(); };
      return group;
    }));
    showVenueEditors(); showSpreadsheetPreview();
    $('confirm-import').textContent = currentTab==='equipment' ? `Import & review ${data.rows.length} rows` : `Review ${data.rows.length} rows`;
    $('confirm-import').disabled = false;
  } catch (error) {
    if(![...$('sheet-choice').options].some(option=>option.value) && /\.xlsx$/i.test(spreadsheetFile.filename)) {
      $('sheet-choice').replaceChildren(new Option('Could not load worksheets',''));
      $('sheet-choice').disabled=true;
    }
    $('spreadsheet-error').textContent = error.message;
    $('spreadsheet-error').hidden = false;
  } finally { $('reload-sheet').disabled = false; }
}
function closeSpreadsheet() {
  if (spreadsheetReviewing) { stopSpreadsheetReview = true; return; }
  $('spreadsheet-dialog').close(); spreadsheetData = null; spreadsheetFile = null; venueEdits = new Map();
}
$('close-spreadsheet').onclick = $('cancel-spreadsheet').onclick = closeSpreadsheet;
$('spreadsheet-dialog').addEventListener('cancel', event => {
  if (spreadsheetReviewing) { event.preventDefault(); stopSpreadsheetReview = true; }
  else { spreadsheetData = null; spreadsheetFile = null; venueEdits = new Map(); }
});
$('reload-sheet').onclick = loadSpreadsheet;
// Sheet/header changes must be loaded before an import can be confirmed.
$('sheet-choice').onchange = $('header-row').oninput = () => { $('confirm-import').disabled = true; };
const meaningfulImportRow = row => Object.entries(row).some(([field,value]) => field==='custom_values'?Object.values(value).some(value=>String(value??'').trim()!==''):field !== 'record_type' && value !== '' && value!=null);
function importAddressKey(row) {
  const ip = (row.ip || '').trim();
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(ip) || ip.split('.').some(part => Number(part) > 255)) return null;
  if ((row.record_type || 'device') === 'device') return `device:${ip}`;
  const port = String(row.port ?? '').trim();
  return /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535 ? `iptv:${ip}:${Number(port)}` : null;
}
function skippedDuplicateImport(entry, row = entry.row) {
  return {added:0, skipped:1, warnings:[`Row ${entry.number}: ${row.name || ''} · ${row.venue || ''} · duplicate IP ${row.ip} already exists in the inventory. Skipped; the first record was kept.`]};
}
let finishRowReview = null, rowReviewSaving = false;
function endRowReview(result) {
  if (rowReviewSaving || !finishRowReview) return;
  const finish = finishRowReview; finishRowReview = null;
  $('row-review-dialog').close(); finish(result);
}
$('stop-row-review').onclick = $('cancel-row-review').onclick = () => endRowReview(null);
$('skip-review-row').onclick = () => endRowReview({skippedRow:true});
$('row-review-dialog').addEventListener('cancel', event => { event.preventDefault(); endRowReview(null); });
function reviewImportRow(entry, index, total, tab, knownAddresses, inventory = null) {
  return new Promise(resolve => {
    finishRowReview = resolve;
    const equipment = tab === 'equipment';
    $('row-review-title').textContent = equipment ? 'Import this equipment?' : tab === 'iptv' ? 'Import this channel?' : 'Import this device?';
    $('row-review-progress').textContent = `Row ${entry.number} · ${index + 1} of ${total} · ${spreadsheetFile.filename}${inventory ? ' · Inventory: ' + inventory.name : ''}`;
    $('row-review-error').hidden = true;
    $('row-review-flags').hidden = !equipment || !entry.issues?.length;
    $('row-review-flags').textContent = equipment && entry.issues?.length ? 'Check: ' + entry.issues.join(' · ') + '. Blank values may remain for follow-up.' : '';
    if (equipment) $('row-review-progress').textContent += ' · ' + entry.locationProgress;
    $('row-review-ip-hint').textContent = tab === 'iptv'
      ? 'There is text in the Multicast IP field. Enter an IPv4 address, leave the field blank, or skip this row.'
      : 'There is text in the IP Address field. Enter an IPv4 address, click DHCP, leave the field blank, or skip this row.';
    const controls = new Map();
    const fields = tab === 'iptv'
      ? [...iptvImportFields.slice(0,3), ['channel_source', 'Type'], ...iptvImportFields.slice(3)]
      : importFields();
    $('row-review-fields').style.setProperty('--review-columns', fields.length);
    $('row-review-fields').replaceChildren(...fields.map(([field, label]) => {
      const group = element('label', '', label.replace(' (optional)', ''));
      const column=equipment?(inventory?.layout || window.equipmentUI.profile()).columns.find(col=>col.key===field):null;
      if (column?.key==='orientation') group.firstChild.textContent += ' (optional)';
      if(column && !inventoryBaseFields.has(field)){const {wrapper,control}=inventoryInput(column,inventoryValue(entry.row,field),{allowClear:field!=='orientation'});control.id=`review-${field}`;group.append(wrapper);controls.set(field,control);return group;}
      const input = element(field === 'channel_source' ? 'select' : field === 'notes' ? 'textarea' : 'input'); input.id = `review-${field}`;
      if (field === 'channel_source') input.append(new Option('Leave blank', ''), new Option('Onboard', 'Onboard'), new Option('Satellite', 'Satellite'));
      if (field === 'notes') input.rows = 1;
      input.value = entry.row[field] ?? ''; input.autocomplete = 'off';
      input.maxLength = field === 'notes' || field === 'description' ? 2000 : 120;
      if (field === 'ip') input.spellcheck = false;
      group.append(input); controls.set(field, input);
      if (field === 'ip') {
        const actions = element('div', 'review-ip-actions');
        const dhcp = tab === 'device' ? element('button', 'choice-button', 'DHCP') : null;
        if (dhcp) { dhcp.type = 'button'; dhcp.id = 'review-dhcp'; }
        const blank = element('button', 'quiet', 'Clear'); blank.type = 'button'; blank.id = 'review-clear-ip';
        const update = () => {
          dhcp?.setAttribute('aria-pressed', String(isDHCP(input.value)));
          $('row-review-ip-hint').hidden = !input.value.trim() || (dhcp && isDHCP(input.value)) || !/[^0-9.\s]/.test(input.value);
        };
        if (dhcp) dhcp.onclick = () => { input.value = 'DHCP'; update(); };
        blank.onclick = () => { input.value = ''; update(); input.focus(); };
        input.oninput = update; update(); if (dhcp) actions.append(dhcp); actions.append(blank); group.append(actions);
      }
      return group;
    }));
    if (tab === 'iptv') {
      const source = controls.get('channel_source');
      let sourceEdited = false;
      source.onchange = () => { sourceEdited = true; };
      controls.get('name').addEventListener('input', () => {
        if (!sourceEdited) source.value = channelSourceFromName(controls.get('name').value);
      });
      const codecIPs = channelCodecIPs(mappedRows().filter((row, index) => spreadsheetData.row_numbers[index] !== entry.number));
      knownAddresses.forEach(key => {
        if (key.startsWith('iptv:') && key.endsWith(':2000')) codecIPs.add(key.split(':')[1]);
      });
      const notes = controls.get('notes');
      let notesEdited = false;
      notes.addEventListener('input', () => { notesEdited = true; });
      const updateCodecNotes = () => {
        if (!notesEdited) notes.value = channelNotesWithCodec({record_type:'iptv', ip:controls.get('ip').value.trim(), port:controls.get('port').value.trim(), notes:entry.row.notes}, codecIPs);
      };
      controls.get('ip').addEventListener('input', updateCodecNotes);
      controls.get('port').addEventListener('input', updateCodecNotes);
      updateCodecNotes();
    }
    if (equipment) $('row-review-ip-hint').hidden = true;
    $('accept-review-row').onclick = async () => {
      if (rowReviewSaving) return;
      const row = {...entry.row};
      row.custom_values=equipment?{...entry.row.custom_values}:entry.row.custom_values;
      controls.forEach((input, field) => { if(equipment&&!inventoryBaseFields.has(field))row.custom_values[field]=input.value.trim();else row[field] = input.value.trim(); });
      if(!equipment)delete row.custom_values;
      if (!equipment) {
        if (isDHCP(row.ip)) row.ip = 'DHCP';
        if (tab === 'device') {
          row.venue = cleanVenue(row.venue);
          if (!/^[0-9]+$/.test(row.vlan)) row.vlan = '';
        }
      } else row.location = cleanVenue(row.location);
      // Clearing the final value makes this an empty row, which needs no write.
      if (!meaningfulImportRow(row)) { endRowReview({skippedRow:true}); return; }
      const addressKey = equipment ? null : importAddressKey(row);
      if (addressKey && knownAddresses.has(addressKey)) { endRowReview(skippedDuplicateImport(entry, row)); return; }
      const dialogControls = [...$('row-review-dialog').querySelectorAll('button,input,select,textarea')];
      rowReviewSaving = true; dialogControls.forEach(control => { control.disabled = true; });
      $('row-review-error').hidden = true;
      let result;
      try {
        result = await api(equipment ? '/api/equipment/import' : '/api/import', 'POST', equipment
          ? {version:1,inventory_id:inventory.id,equipment:[row]}
          : {version:1,devices:[row],source:'spreadsheet',row_numbers:[entry.number]});
        if (result.added && addressKey) knownAddresses.add(addressKey);
      } catch(error) {
        $('row-review-error').textContent = error.message.replace('Nothing was imported.', 'This row was not imported. Previously accepted rows remain saved.');
        $('row-review-error').hidden = false;
      } finally {
        rowReviewSaving = false; dialogControls.forEach(control => { control.disabled = false; });
      }
      if (result) endRowReview(result);
    };
    $('row-review-dialog').showModal();
    $('accept-review-row').focus();
  });
}
$('spreadsheet-form').onsubmit = async event => {
  event.preventDefault();
  if (!spreadsheetData || $('confirm-import').disabled) return;
  $('confirm-import').disabled = true; $('spreadsheet-error').hidden = true;
  spreadsheetReviewing = true; stopSpreadsheetReview = false;
  try {
    const tab = currentTab;
    let entries = mappedRows().map((row,index) => ({row,number:spreadsheetData.row_numbers[index]})).filter(({row}) => meaningfulImportRow(row));
    if (tab === 'equipment') entries = orderEquipmentReview(entries);
    const saved = tab === 'equipment' ? [] : (await api('/api/devices')).devices;
    const knownAddresses = new Set(saved.map(importAddressKey).filter(Boolean));
    let added = 0, existing = 0, skipped = 0, stopped = false;
    const equipmentImportReport = [];
    if(tab==='equipment'&&spreadsheetInventory.layout?.stock_mode==='tv_counts'){const zeroRows=entries.filter(entry=>entry.row.quantity===0&&!entry.row.source_issues?.length);zeroRows.forEach(entry=>equipmentImportReport.push(`Row ${entry.number} · ${entry.row.brand} ${entry.row.model}: Zero total count; skipped. Use Add equipment to add this model later.`));skipped+=zeroRows.length;entries=entries.filter(entry=>entry.row.quantity!==0||entry.row.source_issues?.length);}
    if (tab === 'device') importWarnings = [];
    if (tab === 'equipment') {
      const profile=spreadsheetInventory.layout || defaultInventoryLayout;
      const collect=({entry,result})=>{
        if(entry.issues.length||result.skipped||result.skippedRow) equipmentImportReport.push(`Row ${entry.number} · ${entry.row.location || 'Unassigned'} · ${inventoryValue(entry.row,profile.primary_search) || entry.row.serial_number || entry.row.model || entry.row.description || 'Unnamed item'}: ${result.skipped_zero ? 'Zero total count; not imported. ' : result.skipped ? 'Already exists; not imported. ' : result.skippedRow ? 'Skipped by user. ' : 'Imported for follow-up. '}${entry.issues.join(' · ')}`);
        if(result.skippedRow)skipped++;else {added+=result.added;skipped+=result.skipped_zero || 0;existing+=result.skipped-(result.skipped_zero || 0);}
      };
      for(let index=0;index<entries.length;) {
        if(stopSpreadsheetReview){stopped=true;break;}
        const location=entries[index].row.location;
        let end=index;
        while(end<entries.length&&end<index+8&&entries[end].row.location===location)end++;
        const batch=entries.slice(index,end),remaining=[];
        for(const entry of batch) {
          const complete=$('import-complete-rows').checked && !entry.issues.length && profile.columns.filter(column=>column.key!=='orientation'&&column.type!=='calculated').every(column=>$('map-'+column.key).value!==''&&String(inventoryValue(entry.row,column.key)).trim()!=='');
          if(!complete){remaining.push(entry);continue;}
          try {
            collect({entry,result:await api('/api/equipment/import','POST',{version:1,inventory_id:spreadsheetInventory.id,equipment:[entry.row]})});
          } catch(error) {entry.issues.push(error.message);remaining.push(entry);}
        }
        if(remaining.length) {
          const review=await reviewEquipmentBatch(remaining,index,entries.length,spreadsheetInventory,profile.columns.map(col=>[col.key,col.label]),spreadsheetFile.filename,[...new Set(entries.map(entry=>entry.row.location).filter(Boolean))]);
          review.outcomes.forEach(collect);
          if(review.stopped){stopped=true;break;}
        }
        await load();index=end;
      }
    } else {
      for (let index = 0; index < entries.length; index++) {
        if (stopSpreadsheetReview) { stopped = true; break; }
        const addressKey = tab === 'equipment' ? null : importAddressKey(entries[index].row);
        const result = addressKey && knownAddresses.has(addressKey)
          ? skippedDuplicateImport(entries[index])
          : await reviewImportRow(entries[index], index, entries.length, tab, knownAddresses, spreadsheetInventory);
        if (result === null) { stopped = true; break; }
        if (result.skippedRow) skipped++;
        else {
          added += result.added; existing += result.skipped;
          if (tab === 'device') importWarnings.push(...(result.warnings || []));
          if (result.added) await load();
        }
      }
    }
    if (tab === 'equipment') window.equipmentUI.importReport(spreadsheetInventory.id, equipmentImportReport);
    spreadsheetReviewing = false; closeSpreadsheet();
    toast(`${stopped ? 'Review stopped. ' : ''}Imported ${added} records. Skipped ${skipped} rows and ${existing} existing assignments.`);
    await load();
  } catch(error) { $('spreadsheet-error').textContent = error.message; $('spreadsheet-error').hidden = false; }
  finally { spreadsheetReviewing = false; $('confirm-import').disabled = false; }
};
$('import').onclick = () => $('import-file').click();
$('import-file').onchange = async event => {
  const file = event.target.files[0]; if (!file) return;
  $('import').disabled = true;
  try {
    const importTab = currentTab;
    const importInventory = importTab === 'equipment' ? await window.equipmentUI.waitUntilReady() : null;
    if (file.size > 5_000_000) throw new Error('Choose a file smaller than 5 MB.');
    if (/\.(xlsx|csv)$/i.test(file.name)) {
      const content = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = () => reject(new Error('Could not read file.')); reader.readAsDataURL(file);
      });
      spreadsheetFile = {filename:file.name, content};
      spreadsheetInventory = importInventory;
      spreadsheetData = null; venueEdits = new Map(); $('import-venue-editor').hidden = true;
      $('import-venue-list').replaceChildren(); $('header-row').value = '1'; $('sheet-choice').replaceChildren();$('sheet-choice').disabled=/\.csv$/i.test(file.name);
      $('column-mappings').replaceChildren(); $('spreadsheet-preview').replaceChildren();
      $('spreadsheet-summary').textContent = 'Reading ' + file.name + '…';
      $('spreadsheet-dialog').showModal();
      await loadSpreadsheet();
    } else if (/\.json$/i.test(file.name)) {
      const payload = JSON.parse(await file.text());
      if (importInventory && payload && typeof payload === 'object' && !Array.isArray(payload)) payload.inventory_id = importInventory.id;
      const result = await api(importTab === 'equipment' ? '/api/equipment/import' : '/api/import', 'POST', payload);
      if (currentTab === 'device') importWarnings = result.warnings || [];
      toast(`Imported ${result.added} records. Skipped ${result.skipped} existing assignments.`);
      await load();
    } else throw new Error('Choose .xlsx, .csv, or an avtrack .json export.');
  } catch(error) { toast('Import failed: ' + error.message); }
  finally { event.target.value = ''; $('import').disabled = false; }
};
load();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js').then(() => navigator.serviceWorker.ready).then(() => {
    $('broadcastgab-offline-link').title = 'Saved BroadcastGab copy · available offline';
    $('broadcastgab-cache-status').textContent = 'Available offline';
  }).catch(() => {
    $('broadcastgab-offline-link').title = 'Saved copy · offline storage unavailable in this browser';
    $('broadcastgab-cache-status').textContent = 'Offline storage unavailable';
  });
} else {
  $('broadcastgab-cache-status').textContent = 'Offline storage requires HTTPS and a supported browser';
}
