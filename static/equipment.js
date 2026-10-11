/* Equipment uses its own records and forms, with shared spreadsheet import. */
(() => {
  let items = [], editingId = null, deletingItem = null;
  let visibleItems = [];
  const customFilterValues = new Map();
  let formCustomControls = new Map();
  let layoutDraft = null, layoutTarget = null, layoutAfterSave = null;
  const layout = () => inventories.find(i => i.id === inventoryId)?.layout || defaultInventoryLayout;
  const displayColumns = () => layout().columns;
  const showLocatedStatus = () => layout().show_status !== false;
  const importReports = new Map();
  const crossChecks = new Map();
  const selectedItems = new Set();
  const pendingConfirmations = new Map();
  let inventoryId = 1, inventories = [], inventoryReady = false, loadVersion = 0;
  let formInventoryId = 1, renamingInventoryId = null;
  let inventoryLoad = Promise.resolve();
  try { inventoryId = Number(localStorage.getItem('avtrack-equipment-inventory')) || 1; } catch (_) {}
  const currentInventory = () => {
    if (!inventoryReady) throw new Error('Wait for the inventory to finish loading.');
    return {...inventories.find(inventory => inventory.id === inventoryId)};
  };
  function resetEquipmentFilters(switchedInventory = false) {
    if (switchedInventory) {
      customFilterValues.clear();
      selectedItems.clear();
      $('equipment-export-scope').value = 'filtered';
    }
    ['equipment-search','equipment-location-filter','equipment-status-filter','equipment-review-filter'].forEach(id => { $(id).value = ''; });
    $('equipment-status-buttons').querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.value === '')));
  }
  const equipmentForm = $('equipment-form');
  const fields = ['description','brand','model','serial_number','quantity','location','notes'];
  const label = field => field === 'description' ? 'Item' : field.replaceAll('_', ' ').replace(/^./, s => s.toUpperCase());
  const displayName = item => String(inventoryValue(item,layout().primary_search) || [item.brand,item.model].filter(Boolean).join(' ') || `record ${item.id}`);
  function updateEquipmentSelection() {
    const visibleSelected = visibleItems.filter(item => selectedItems.has(item.id)).length;
    const check = $('select-visible-equipment');
    check.disabled = !visibleItems.length;
    check.checked = !!visibleItems.length && visibleSelected === visibleItems.length;
    check.indeterminate = visibleSelected > 0 && visibleSelected < visibleItems.length;
    $('equipment-rows').querySelectorAll('.row-select').forEach(checkbox => { checkbox.checked = selectedItems.has(Number(checkbox.dataset.recordId)); });
    $('equipment-selection-summary').hidden = !selectedItems.size;
    $('equipment-selection-count').textContent = `${selectedItems.size} selected`;
    updateExportScope('equipment-export-scope', visibleItems.length, selectedItems.size, items.length);
  }
  $('select-visible-equipment').onchange = event => {
    visibleItems.forEach(item => event.target.checked ? selectedItems.add(item.id) : selectedItems.delete(item.id));
    if (selectedItems.size) $('equipment-export-scope').value = 'selected';
    updateEquipmentSelection();
  };
  $('clear-equipment-selection').onclick = () => { selectedItems.clear(); updateEquipmentSelection(); };
  function loadEquipment(targetId = inventoryId) {
    inventoryLoad = fetchEquipment(targetId);
    return inventoryLoad;
  }
  async function fetchEquipment(targetId) {
    const version = ++loadVersion, previouslyReady = inventoryReady;
    inventoryReady = false;
    $('equipment-refresh').disabled = true;
    ['equipment-inventory-select','new-equipment-inventory','rename-equipment-inventory','delete-equipment-inventory','equipment-import'].forEach(id => { $(id).disabled = true; });
    $('equipment-rows').inert = true;
    try {
      await Promise.all([...pendingConfirmations.values()]);
      const catalog = (await api('/api/equipment/inventories')).inventories;
      const target = catalog.find(inventory => inventory.id === targetId) || catalog.find(inventory => inventory.id === 1) || catalog[0];
      const records = (await api(`/api/equipment?inventory_id=${target.id}`)).equipment;
      if (version !== loadVersion) return false;
      if (inventoryId !== target.id) resetEquipmentFilters(true);
      inventoryId = target.id; inventories = catalog; items = records; inventoryReady = true;
      $('equipment-inventory-select').replaceChildren(...catalog.map(inventory => new Option(inventory.name, inventory.id)));
      $('equipment-inventory-select').value = String(inventoryId);
      $('equipment-inventory-title').textContent = target.name;
      try { localStorage.setItem('avtrack-equipment-inventory', inventoryId); } catch (_) {}
      $('equipment-error').hidden = true;
      options('equipment-location-filter', items.map(i => i.location));
      $('equipment-location-options').replaceChildren(...[...new Set(items.map(i => i.location))].map(v => new Option(v,v)));
      renderEquipment();
      await loadOverview();
      return true;
    } catch(error) {
      if (version !== loadVersion) return false;
      inventoryReady = previouslyReady;
      $('equipment-inventory-select').value = String(inventoryId);
      $('equipment-error').textContent = 'Could not load equipment. ' + error.message;
      $('equipment-error').hidden = false;
      return false;
    } finally {
      if (version === loadVersion) {
        $('equipment-refresh').disabled = false;
        ['equipment-inventory-select','new-equipment-inventory','rename-equipment-inventory','delete-equipment-inventory','equipment-import'].forEach(id => { $(id).disabled = !inventoryReady; });
        $('equipment-rows').inert = !inventoryReady;
      }
    }
  }
  function renderEquipment() {
    updatePageSummary(items, inventories.find(inventory => inventory.id === inventoryId)?.name || 'Equipment inventory',layout());

    renderInventoryColumns();
    renderLocationButtons();
    renderCustomFilters();
    const query = $('equipment-search').value.trim().toLowerCase();
    const reviewFilter = $('equipment-review-filter').value;
    const flaggedCount=items.filter(i => !i.data_checked && equipmentIssues(i).length).length;
    const flaggedLink=element('a','',`${flaggedCount} flagged`);
    flaggedLink.href='#equipment-table';flaggedLink.onclick=showFlaggedEquipment;
    $('equipment-review-summary').replaceChildren(
      document.createTextNode(`${items.filter(i => !i.data_checked).length} records not checked · `),
      flaggedCount ? flaggedLink : document.createTextNode('0 flagged'),
      document.createTextNode(showLocatedStatus() ? ` · ${items.filter(i => !i.item_confirmed).length} locations not confirmed` : ''));
    const results = items.filter(item => (layout().stock_mode!=='tv_counts'||$('equipment-show-zero').checked||item.quantity!==0) && [...fields.map(field=>item[field]),...Object.values(item.custom_values || {}),
      ...(showLocatedStatus() ? [item.item_confirmed ? 'Located' : 'Not located'] : []),
      item.data_checked ? 'Record checked' : equipmentIssues(item).length ? 'Check flagged record' : 'Check record'
    ].some(value => String(value ?? '').toLowerCase().includes(query)) &&
      [...customFilterValues].every(([key,value]) => !value || String(inventoryValue(item,key)) === value) &&
      (!$('equipment-location-filter').value || item.location === $('equipment-location-filter').value) &&
      (!$('equipment-status-filter').value || Boolean(item.item_confirmed) === ($('equipment-status-filter').value === 'found')) &&
      (!reviewFilter || (reviewFilter === 'checked' ? item.data_checked : reviewFilter === 'pending' ? !item.data_checked : !item.data_checked && equipmentIssues(item).length)));
    if (query) results.sort((a,b) => {
      const rank = item => String(inventoryValue(item,layout().primary_search)).toLowerCase() === query ? 0 : String(inventoryValue(item,layout().primary_search)).toLowerCase().includes(query) ? 1 : item.serial_number.toLowerCase().includes(query) ? 2 : item.model.toLowerCase().includes(query) ? 3 : 4;
      return rank(a) - rank(b);
    });
    visibleItems = results;
    const availableIds = new Set(results.map(item => item.id));
    for (const id of selectedItems) if (!availableIds.has(id)) selectedItems.delete(id);
    const storage=layout().location_role!=='geographic' && layout().location_role!=='none' && !currentInventory().name.toLowerCase().includes('scala');
    $('equipment-locations').closest('div').hidden=!storage;
    $('equipment-manage-locations').hidden=!storage;
    $('equipment-zero-label').hidden=layout().stock_mode!=='tv_counts';
    document.querySelector('.equipment-stats').style.gridTemplateColumns=`repeat(${2+Number(storage)+Number(showLocatedStatus())},minmax(0,1fr))`;
    if(!displayColumns().some(col=>col.key==='quantity'||col.type==='count'||col.type==='calculated')){$('equipment-units').textContent=items.length;}
    $('equipment-records').textContent = items.length;
    $('equipment-units').textContent = displayColumns().some(col=>col.key==='quantity'||col.type==='count'||col.type==='calculated')?items.reduce((total,item) => total + (item.quantity ?? 0), 0):items.length;
    $('equipment-units').title = 'Sum of known quantities; blank quantities are not counted.';
    $('equipment-locations').textContent = new Set(items.map(i => i.location).filter(Boolean)).size;
    $('equipment-found').textContent = items.filter(item => item.item_confirmed).length;
    $('equipment-result-count').textContent = results.length;
    $('equipment-showing').textContent = `${results.length} of ${items.length} items`+(showLocatedStatus() ? ` · ${results.filter(item => item.item_confirmed).length} located in this view` : '');
    $('equipment-found').closest('div').hidden=!showLocatedStatus();
    document.querySelector('.equipment-stats').classList.toggle('without-status',!showLocatedStatus());
    $('equipment-empty').hidden = items.length > 0;
    $('equipment-no-results').hidden = !items.length || !!results.length;
    $('equipment-table').hidden = !results.length;
    $('equipment-rows').replaceChildren(...results.map(item => {
      const row = element('tr');
      row.dataset.itemId = item.id;
      displayColumns().forEach((column,index) => {
        const field=column.key;
        const cell = element('td', '', inventoryValue(item,field));
        if (index === 0) {
          const value = element('div', 'equipment-brand-value');
          value.append(selectionControl(item.id, `equipment ${displayName(item)}`, selectedItems, () => {
            if (selectedItems.size) $('equipment-export-scope').value = 'selected';
            updateEquipmentSelection();
          }), element('span', '', inventoryValue(item,field)));
          cell.replaceChildren(value);
        }
        if((!inventoryBaseFields.has(field)||field==='quantity')&&(field==='orientation'||['checkbox','buttons','select','count'].includes(column.type))){
          const {wrapper,control}=inventoryInput(column,inventoryValue(item,field));wrapper.classList.add('inventory-cell-controls');
          control.onchange=async()=>{
            if(pendingConfirmations.has(item.id))return;
            const write=api(`/api/equipment/${item.id}`,'PUT',inventoryBaseFields.has(field)?{...item,[field]:control.value}:{...item,custom_values:{...item.custom_values,[field]:control.value}});
            pendingConfirmations.set(item.id,write);wrapper.querySelectorAll('input,button,select').forEach(node=>{node.disabled=true;});
            try{const updated=await write;items=items.map(record=>record.id===updated.id?updated:record);}
            catch(error){toast('Could not update '+column.label+': '+error.message);}
            finally{pendingConfirmations.delete(item.id);renderEquipment();}
          };
          cell.replaceChildren(wrapper);
          if(index===0){wrapper.prepend(selectionControl(item.id,`equipment ${displayName(item)}`,selectedItems,updateEquipmentSelection));}
        }
        if(field==='location'&&column.type==='location'&&inventoryValue(item,field)){const button=element('button','choice-button',item.location);button.type='button';colorVenueButton(button,item.location);button.onclick=()=>{$('equipment-location-filter').value=item.location;renderEquipment();};cell.replaceChildren(button);}
        cell.title = String(inventoryValue(item,field));
        cell.dataset.label = column.label; row.append(cell);
        if (index === displayColumns().length-1) {
          const review = element('td', 'equipment-review'); review.dataset.label = 'Record check';
          const issues = equipmentIssues(item);
          const button = element('button', item.data_checked ? 'quiet record-checked' : 'quiet', item.data_checked ? 'Record checked' : issues.length ? 'Check flagged record' : 'Check record');
          button.type = 'button'; button.disabled = pendingConfirmations.has(item.id);
          button.title = issues.join(' · ') || 'Verify against the old inventory file';
          button.setAttribute('aria-label', `Review record ${displayName(item)}`);
          button.onclick = async () => {
            $('equipment-record-review-details').textContent = `${item.serial_number || 'No serial'} · ${displayName(item)} · ${item.location || 'No location'} · Quantity ${item.quantity ?? 'unknown'}`;
            $('equipment-record-review-issues').textContent = issues.length ? issues.join(' · ') + '. Use Edit to correct the record, or acknowledge these blanks after checking the source.' : 'Check these details against the old inventory file.';
            $('equipment-record-review-error').hidden = true;
            $('edit-equipment-record-review').onclick = () => { $('equipment-record-review-dialog').close(); openEquipment(item); };
            $('save-equipment-record-review').onclick = async () => {
              const control = $('save-equipment-record-review'); control.disabled = true;
              const write = api(`/api/equipment/${item.id}/review`, 'POST', {...item, data_checked:true}); pendingConfirmations.set(item.id, write);
              try { const updated = await write; items = items.map(i => i.id === updated.id ? updated : i); $('equipment-record-review-dialog').close(); }
              catch(error) { $('equipment-record-review-error').textContent = error.message; $('equipment-record-review-error').hidden = false; }
              finally { pendingConfirmations.delete(item.id); control.disabled = false; renderEquipment(); }
            };
            $('equipment-record-review-dialog').showModal();
          };
          review.append(button); row.append(review);

          if(showLocatedStatus()) {
          const status = element('td', 'equipment-status'); status.dataset.label = 'Status';
          const control = element('label', `equipment-confirm-label${item.item_confirmed ? ' confirmed' : ''}`);
          const check = element('input', 'equipment-confirm'); check.type = 'checkbox';
          check.checked = Boolean(item.item_confirmed); check.disabled = pendingConfirmations.has(item.id);
          check.setAttribute('aria-label', `Mark equipment ${displayName(item)} as located`);
          control.append(check, element('span', '', item.item_confirmed ? 'Located' : 'Not located'));
          check.onchange = async () => {
            const write = api(`/api/equipment/${item.id}/confirm`, 'POST', {...item, item_confirmed:check.checked});
            pendingConfirmations.set(item.id, write); check.disabled = true;
            try {
              const updated = await write;
              items = items.map(record => record.id === updated.id ? updated : record);
            } catch(error) { toast('Could not update located status: ' + error.message); }
            finally { pendingConfirmations.delete(item.id); renderEquipment(); }
          };
          if(layout().template){const button=element('button',`ip-confirm${item.item_confirmed?' confirmed':' pending'}`,item.item_confirmed?'Located':'Not located');button.type='button';button.disabled=check.disabled;button.setAttribute('aria-pressed',String(!!item.item_confirmed));button.setAttribute('aria-label',check.getAttribute('aria-label'));button.onclick=()=>{button.disabled=true;check.checked=!check.checked;check.onchange();};status.append(button);}else status.append(control); row.append(status);
          }
        }
      });
      const actions = element('td', 'equipment-actions'); actions.dataset.label = 'Actions';
      const edit = element('button', 'quiet', 'Edit'); edit.setAttribute('aria-label', `Edit equipment ${displayName(item)}`); edit.onclick = () => openEquipment(item);
      const remove = element('button', 'quiet', 'Delete'); remove.setAttribute('aria-label', `Delete equipment ${displayName(item)}`);
      remove.onclick = () => {
        deletingItem = item;
        $('equipment-delete-description').textContent = `${displayName(item)} · Quantity ${item.quantity} · ${item.location}`;
        $('equipment-delete-error').hidden = true;
        $('equipment-delete-dialog').showModal(); $('cancel-equipment-delete').focus();
      };
      actions.append(edit,remove); row.append(actions); return row;
    }));
    $('equipment-import-report').hidden = !importReports.get(inventoryId)?.length;
    $('equipment-import-report-list').replaceChildren(...(importReports.get(inventoryId) || []).map(text => element('li', '', text)));
    renderCrossCheck();
    updateEquipmentSelection();
  }
  function renderInventoryColumns() {
    const heading=$('select-visible-equipment').closest('label');
    heading.querySelector('span').textContent=displayColumns()[0].label;
    const baseWidths={description:140,brand:80,model:100,serial_number:120,quantity:65,location:110,notes:120};
    const widths=displayColumns().map((col,index)=>{
      const labelWidth=Math.min(220,col.label.length*8+20+(index===0?30:0));
      const controlWidth=col.key==='orientation' ? Math.max(164,(col.options || []).reduce((width,value)=>width+value.length*6+24,8)) : col.type==='buttons' ? (col.options || []).reduce((width,value)=>width+value.length*6+24,0) : col.type==='checkbox' ? 100 : 0;
      return Math.max(baseWidths[col.key] || 120,labelWidth,controlWidth);
    });
    widths.push(115,...(showLocatedStatus()?[110]:[]),96);
    const totalWidth=widths.reduce((total,width)=>total+width,0);
    const columns=displayColumns().map((col,index)=>{const th=element('th','',index===0?'':col.label);th.scope='col';if(index===0)th.append(heading);th.style.width=`${widths[index]/totalWidth*100}%`;return th;});
    ['Record check',...(showLocatedStatus()?['Status']:[]),'Actions'].forEach((text,index)=>{const th=element('th','',text);th.scope='col';th.style.width=`${widths[displayColumns().length+index]/totalWidth*100}%`;columns.push(th);});
    $('equipment-table').querySelector('thead tr').replaceChildren(...columns);
    $('equipment-table').style.minWidth=`${Math.max(850,totalWidth)}px`;
    $('equipment-search').placeholder='Search all inventory columns…';
    $('equipment-search').title='Search item, brand, model, serial number, quantity, location, notes, status and custom columns.';
    document.querySelector('.equipment-status-group').hidden=!showLocatedStatus();
    if(!showLocatedStatus())$('equipment-status-filter').value='';
    const location=displayColumns().find(col=>col.key==='location');
    $('equipment-location-filter-label').hidden=!location || location.filter==='none';
    $('equipment-location-buttons').hidden=location?.filter!=='buttons';
    if (!location || location.filter==='none') $('equipment-location-filter').value='';
  }
  function renderCustomFilters() {
    $('equipment-custom-filters').replaceChildren(...displayColumns().filter(col=>col.key!=='location'&&col.filter!=='none').map(col=>{
      const group=element('fieldset','button-filter');group.append(element('legend','',col.label));
      const values=[...new Set(items.map(item=>String(inventoryValue(item,col.key))).filter(Boolean))].sort(nameCollator.compare);
      if(col.filter==='buttons') {
        const buttons=element('div','choice-buttons');
        ['',...values].forEach(value=>{const button=element('button','choice-button',value || 'All');button.type='button';button.setAttribute('aria-pressed',String((customFilterValues.get(col.key)||'')===value));button.onclick=()=>{customFilterValues.set(col.key,value);renderEquipment();};buttons.append(button);});group.append(buttons);
      } else {
        const select=element('select');select.setAttribute('aria-label',`Filter ${col.label}`);select.append(new Option('All',''),...values.map(value=>new Option(value,value)));select.value=customFilterValues.get(col.key)||'';select.onchange=()=>{customFilterValues.set(col.key,select.value);renderEquipment();};group.append(select);
      }
      return group;
    }));
    $('equipment-custom-filters').hidden=!$('equipment-custom-filters').children.length;
  }
  function renderColumnEditor() {
    const selectedSearch=$('inventory-primary-search').value || layoutDraft.primary_search;
    const selectedIdentifier=$('inventory-identifier').value || layoutDraft.identifier;
    $('inventory-primary-search').replaceChildren(...layoutDraft.columns.map(col=>new Option(col.label,col.key)));
    if(layoutDraft.columns.some(col=>col.key===selectedSearch)) $('inventory-primary-search').value=selectedSearch;
    $('inventory-identifier').replaceChildren(new Option('No unique identifier',''),...layoutDraft.columns.filter(col=>!['location','quantity','notes'].includes(col.key)&&!['checkbox','buttons'].includes(col.type)).map(col=>new Option(col.label,col.key)));
    $('inventory-identifier').value=selectedIdentifier || '';
    $('inventory-identifier').disabled=layoutDraft.stock_mode==='tv_counts';
    $('inventory-identifier').closest('label').querySelector('small').textContent=layoutDraft.stock_mode==='tv_counts'?'TV rows are identified by Brand and Model together. Repeated models are flagged for review.':'Optional. An ID or serial identifies one item; repeated identifiers are skipped on import.';
    $('inventory-column-list').replaceChildren(...layoutDraft.columns.map((col,index)=>{
      const row=element('div','inventory-column-editor');row.dataset.columnKey=col.key;
      const name=element('label','', 'Column name');const input=element('input');input.value=col.label;input.maxLength=120;input.setAttribute('aria-label',`Column ${index+1} name`);input.onchange=()=>{col.label=input.value.trim();layoutDraft.primary_search=$('inventory-primary-search').value;layoutDraft.identifier=$('inventory-identifier').value;renderColumnEditor();};name.append(input);
      const kind=element('label','', 'Control');const type=element('select');type.setAttribute('aria-label',`Control for ${col.label}`);[['text','Text box'],['checkbox','Checkbox'],['select','Dropdown'],['buttons','Button choices'],['count',col.minimum===0?'Count (0–50)':'Count (1–50)'],...(col.key==='location'?[['location','Imported locations']]:[]),...(col.type==='calculated'?[['calculated','Calculated total']]:[])].forEach(([value,label])=>type.append(new Option(label,value)));type.value=col.type;type.onchange=()=>{if(inventoryBaseFields.has(col.key)&&!(type.value==='text'||type.value==='count'&&col.key==='quantity'||type.value==='location'&&col.key==='location')){col.key='custom_'+col.key;}col.type=type.value;if(col.type==='count')col.minimum=col.minimum ?? 1;delete col.sources;if(col.key==='total_count'&&col.type!=='calculated')delete layoutDraft.stock_mode;renderColumnEditor();};kind.append(type);
      const filter=element('label','', 'Filter');const select=element('select');select.setAttribute('aria-label',`Filter for ${col.label}`);select.append(new Option('No filter','none'),new Option('Dropdown','dropdown'),new Option('Buttons','buttons'));select.value=col.filter;select.onchange=()=>{col.filter=select.value;};filter.append(select);
      const important=element('label','inventory-column-important');const check=element('input');check.type='checkbox';check.checked=col.important;check.onchange=()=>{col.important=check.checked;};important.append(check,element('span','','Important'));
      const choices=element('label','', 'Choices, separated by commas');const options=element('input');options.value=col.options.join(', ');options.setAttribute('aria-label',`Choices for ${col.label}`);options.oninput=()=>{col.options=options.value.split(',').map(x=>x.trim()).filter(Boolean);};choices.append(options);choices.hidden=!['select','buttons'].includes(col.type);
      const actions=element('div','inventory-column-actions');
      [['Up',-1],['Down',1]].forEach(([text,direction])=>{const button=element('button','quiet',text);button.type='button';button.disabled=index+direction<0||index+direction>=layoutDraft.columns.length;button.onclick=()=>{const target=index+direction;[layoutDraft.columns[index],layoutDraft.columns[target]]=[layoutDraft.columns[target],layoutDraft.columns[index]];renderColumnEditor();};actions.append(button);});
      const remove=element('button','quiet','Delete column');remove.type='button';remove.setAttribute('aria-label',`Delete ${col.label} column`);remove.onclick=()=>{layoutDraft.columns.splice(index,1);layoutDraft.columns.filter(column=>column.type==='calculated').forEach(column=>{column.sources=column.sources.filter(key=>key!==col.key);});layoutDraft.columns=layoutDraft.columns.filter(column=>column.type!=='calculated'||column.sources.length);if(layoutDraft.stock_mode==='tv_counts'&&!['brand','model','total_count'].every(key=>layoutDraft.columns.some(column=>column.key===key)))delete layoutDraft.stock_mode;renderColumnEditor();};actions.append(remove);row.append(name,kind,filter,important,choices,actions);return row;
    }));
  }
  function openColumns({newName=null, importing=false, template='custom'}={}) {
    layoutTarget=newName?{name:newName}:currentInventory();layoutAfterSave=(importing||newName)?()=> $('import-file').click():null;
    layoutDraft=structuredClone(newName?(inventoryTemplates.find(item=>item.id===template)?.layout || {columns:[],primary_search:'',identifier:''}):layout());
    $('inventory-column-preset').replaceChildren(new Option('Custom columns','custom'),...inventoryTemplates.map(item=>new Option(item.name,item.id)));
    const help=$('inventory-template-help')||element('p','dialog-intro');help.id='inventory-template-help';help.textContent=inventoryTemplates.find(item=>item.id===template)?.description || '';if(!help.isConnected)$('inventory-column-preset').closest('label').after(help);
    $('inventory-column-preset').value=newName?template:(layout().template || 'custom');$('inventory-new-column-name').value='';$('inventory-columns-error').hidden=true;
    $('inventory-columns-title').textContent=newName?`Columns for ${newName}`:importing?'Step 1: choose inventory columns':'Choose columns and filters';
    $('save-inventory-columns').textContent=importing?'Next: choose import file':newName?'Create & choose import file':'Save columns';
    $('inventory-primary-search').replaceChildren();$('inventory-identifier').replaceChildren();renderColumnEditor();$('inventory-columns-dialog').showModal();
  }
  $('inventory-add-column').onclick=()=>{
    const name=$('inventory-new-column-name').value.trim();if(!name)return;
    const aliases={'item':'description','brand':'brand','model':'model','serial number':'serial_number','quantity':'quantity','location':'location','notes':'notes','id':'asset_id','monitor model':'monitor_model','orientation':'orientation'};
    let key=aliases[name.toLowerCase()]||'custom_'+name.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'').slice(0,32);if(key==='custom_')key='custom_column';
    if(layoutDraft.columns.some(col=>col.key===key)){toast('This column is already in the inventory.');return;}
    layoutDraft.columns.push({key,label:name,type:key==='orientation'?'buttons':'text',important:key!=='orientation',filter:'none',options:key==='orientation'?['Vertical','Horizontal']:[]});$('inventory-new-column-name').value='';renderColumnEditor();
  };
  $('inventory-new-column-name').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();$('inventory-add-column').click();}};
  $('inventory-column-preset').onchange=()=>{
    const preset=$('inventory-column-preset').value;$('inventory-template-help').textContent=inventoryTemplates.find(item=>item.id===preset)?.description || '';layoutDraft=structuredClone(inventoryTemplates.find(item=>item.id===preset)?.layout || {columns:[],primary_search:'',identifier:''});$('inventory-primary-search').replaceChildren();$('inventory-identifier').replaceChildren();renderColumnEditor();
  };
  for(const id of ['close-inventory-columns','cancel-inventory-columns']) $(id).onclick=()=> $('inventory-columns-dialog').close();
  $('inventory-columns-form').onsubmit=async event=>{
    event.preventDefault();$('save-inventory-columns').disabled=true;$('inventory-columns-error').hidden=true;
    try {
      layoutDraft.primary_search=$('inventory-primary-search').value;layoutDraft.identifier=$('inventory-identifier').value;
      const inventory=await api(layoutTarget.id?`/api/equipment/inventories/${layoutTarget.id}`:'/api/equipment/inventories',layoutTarget.id?'PUT':'POST',{name:layoutTarget.name,layout:layoutDraft});
      const next=layoutAfterSave;$('inventory-columns-dialog').close();customFilterValues.clear();await loadEquipment(inventory.id);if(next)next();else toast('Inventory columns saved.');
    } catch(error){$('inventory-columns-error').textContent=error.message;$('inventory-columns-error').hidden=false;}
    finally{$('save-inventory-columns').disabled=false;}
  };
  $('equipment-configure-columns').onclick=async()=>{try{await inventoryTemplatesReady;openColumns();}catch(error){toast(error.message);}};
  function showFlaggedEquipment(event) {
    event?.preventDefault();
    customFilterValues.clear();
    resetEquipmentFilters();
    $('equipment-review-filter').value='flagged';
    renderEquipment();
    const destination=visibleItems.length ? $('equipment-table') : $('equipment-no-results');
    destination.scrollIntoView({block:'center',behavior:'smooth'});
    const firstReview=$('equipment-rows').querySelector('.equipment-review button');
    (firstReview || $('equipment-review-filter')).focus({preventScroll:true});
  }
  $('equipment-import-flagged-link').onclick=showFlaggedEquipment;
  const locations = () => [...new Set(items.map(i => i.location).filter(Boolean))].sort(nameCollator.compare);
  function renderLocationButtons() {
    const selected = $('equipment-location-filter').value;
    $('equipment-manage-locations').disabled = !inventoryReady || !locations().length;
    if(!displayColumns().some(col=>col.key==='location'&&col.filter==='buttons')){$('equipment-location-buttons').replaceChildren();return;}
    $('equipment-location-buttons').replaceChildren(...locations().map(location => {
      const button = element('button', 'choice-button', location);
      button.type = 'button'; button.setAttribute('aria-pressed', String(selected === location));
      if (location) colorVenueButton(button, location);
      button.onclick = () => { $('equipment-location-filter').value = location; renderEquipment(); };
      return button;
    }));
  }
  function updateLocationAction() {
    const source = $('equipment-location-source').value;
    const previous = $('equipment-location-target').value;
    $('equipment-location-target').replaceChildren(...locations().filter(value => value !== source).map(value => new Option(value, value)));
    if (locations().includes(previous) && previous !== source) $('equipment-location-target').value = previous;
    const merging = $('equipment-location-action').value === 'merge';
    $('equipment-location-target-label').hidden = !merging;
    $('equipment-location-target').required = merging;
    const count = items.filter(item => item.location === source).length;
    $('equipment-location-impact').textContent = `${count} equipment record${count === 1 ? '' : 's'} will ${merging ? 'move to the destination location' : 'have their location cleared'}.`;
    $('save-equipment-locations').textContent = merging ? 'Merge location' : 'Delete location label';
    $('save-equipment-locations').disabled = !source || (merging && !$('equipment-location-target').value);
    $('equipment-location-error').hidden = true;
  }
  $('equipment-manage-locations').onclick = () => {
    currentInventory();
    $('equipment-location-source').replaceChildren(...locations().map(value => new Option(value, value)));
    if ($('equipment-location-filter').value) $('equipment-location-source').value = $('equipment-location-filter').value;
    $('equipment-location-action').value = locations().length > 1 ? 'merge' : 'delete';
    updateLocationAction(); $('equipment-location-dialog').showModal();
  };
  for (const id of ['equipment-location-source', 'equipment-location-action']) $(id).onchange = updateLocationAction;
  for (const id of ['close-equipment-locations', 'cancel-equipment-locations']) $(id).onclick = () => $('equipment-location-dialog').close();
  $('equipment-location-form').onsubmit = async event => {
    event.preventDefault(); $('save-equipment-locations').disabled = true;
    try {
      await inventoryLoad;
      const result = await api('/api/equipment/locations', 'POST', {
        inventory_id: currentInventory().id,
        source: $('equipment-location-source').value, action: $('equipment-location-action').value,
        target: $('equipment-location-target').value
      });
      $('equipment-location-filter').value = '';
      $('equipment-location-dialog').close(); toast(`Updated ${result.updated} equipment records.`); await loadEquipment();
    } catch(error) { $('equipment-location-error').textContent = error.message; $('equipment-location-error').hidden = false; }
    finally { $('save-equipment-locations').disabled = false; }
  };
  function openEquipment(item = null) {
    if (!inventoryReady) { toast('Wait for the inventory to finish loading.'); return; }
    formInventoryId = item?.inventory_id ?? inventoryId;
    editingId = item?.id ?? null;
    equipmentForm.reset(); $('equipment-form-error').hidden = true;
    $('equipment-form-title').textContent = editingId ? 'Edit equipment' : 'Add equipment';
    $('save-equipment').textContent = editingId ? 'Save changes' : 'Save equipment';
    fields.forEach(field=>{const input=equipmentForm.elements[field];const label=input.closest('label');const col=displayColumns().find(col=>col.key===field);label.hidden=!col;if(!col){input.value=item?.[field] ?? '';return;}
      const {wrapper,control}=inventoryInput(col,inventoryValue(item || {},field),{locations:locations()});control.id='equipment-'+field;control.name=field;
      const oldWrapper=input.closest('.inventory-value-input');(oldWrapper || input).replaceWith(wrapper);
      if(label.firstChild.nodeType===Node.TEXT_NODE)label.firstChild.textContent=col.label+' ';
      if(col.type==='location'){const name=element('input');name.type='text';name.maxLength=120;name.placeholder='New storage location';name.setAttribute('aria-label','New storage location');name.hidden=true;const add=element('button','quiet','New location');add.type='button';add.onclick=()=>{if(name.hidden){name.hidden=false;add.textContent='Add location';name.focus();return;}if(name.value.trim()){control.add(new Option(name.value.trim(),name.value.trim()));control.value=name.value.trim();name.value='';name.hidden=true;add.textContent='New location';}};wrapper.append(name,add);}
    });
    formCustomControls=new Map();
    $('equipment-custom-fields').replaceChildren(...displayColumns().filter(col=>!inventoryBaseFields.has(col.key)).map(col=>{const group=element('div');group.append(element('span','',col.label));const initial=inventoryValue(item || {},col.key) || (col.type==='count'&&col.minimum===0?'0':'');const {wrapper,control}=inventoryInput(col,initial);group.append(wrapper);formCustomControls.set(col.key,control);return group;}));
    const updateTotal=()=>{const row=inventoryCalculate({custom_values:Object.fromEntries([...formCustomControls].map(([key,input])=>[key,input.value]))},layout());displayColumns().filter(col=>col.type==='calculated').forEach(col=>{formCustomControls.get(col.key).value=inventoryValue(row,col.key);});};
    formCustomControls.forEach((input,key)=>{if(displayColumns().some(col=>col.key===key&&col.type==='count'))input.onchange=updateTotal;});updateTotal();
    equipmentForm.dataset.originalCustom=JSON.stringify(item?.custom_values || {});
    $('equipment-dialog').showModal();
  }
  equipmentForm.onsubmit = async event => {
    event.preventDefault(); $('save-equipment').disabled = true;
    $('equipment-form-error').hidden = true;
    try {
      await api(editingId ? `/api/equipment/${editingId}` : '/api/equipment', editingId ? 'PUT' : 'POST', {...Object.fromEntries(new FormData(equipmentForm)), inventory_id:formInventoryId,custom_values:{...JSON.parse(equipmentForm.dataset.originalCustom||'{}'),...Object.fromEntries([...formCustomControls].map(([key,input])=>[key,input.value]))}});
      $('equipment-dialog').close(); toast(editingId ? 'Equipment updated.' : 'Equipment added.'); await loadEquipment();
    } catch(error) { $('equipment-form-error').textContent = error.message; $('equipment-form-error').hidden = false; }
    finally { $('save-equipment').disabled = false; }
  };
  for (const id of ['close-equipment','cancel-equipment']) $(id).onclick = () => $('equipment-dialog').close();
  $('equipment-empty-add').onclick = () => openEquipment();
  $('equipment-refresh').onclick = () => loadEquipment();
  $('equipment-inventory-select').onchange = event => loadEquipment(Number(event.target.value));
  async function openInventoryForm(rename = false) {
    if (!inventoryReady) return;
    try{await inventoryTemplatesReady;}catch(error){toast(error.message);return;}
    $('equipment-template-label').hidden=rename;
    $('equipment-template').replaceChildren(...inventoryTemplates.map(item=>new Option(item.name,item.id)),new Option('Custom inventory','custom'));
    const describe=()=>{$('equipment-template-description').textContent=inventoryTemplates.find(item=>item.id===$('equipment-template').value)?.description || 'Choose your own columns in the next step.';};$('equipment-template').onchange=describe;describe();
    renamingInventoryId = rename ? inventoryId : null;
    $('equipment-inventory-form').reset();
    $('equipment-inventory-name').value = rename ? currentInventory().name : '';
    $('equipment-inventory-form-title').textContent = rename ? 'Rename inventory' : 'New inventory';
    $('save-equipment-inventory').textContent = rename ? 'Save name' : 'Create inventory';
    $('equipment-inventory-form-error').hidden = true;
    $('equipment-inventory-dialog').showModal(); $('equipment-inventory-name').focus();
  }
  $('new-equipment-inventory').onclick = () => openInventoryForm();
  $('rename-equipment-inventory').onclick = () => openInventoryForm(true);
  let deletingInventory = null, inventoryDeletionPending = false;
  $('delete-equipment-inventory').onclick = () => {
    if (!inventoryReady) return;
    deletingInventory = currentInventory();
    $('delete-inventory-description').textContent = `Delete “${deletingInventory.name}” and all ${items.length} item${items.length === 1 ? '' : 's'} in it?`;
    $('delete-inventory-last').hidden = inventories.length !== 1;
    $('delete-inventory-error').hidden = true;
    $('delete-inventory-dialog').showModal();
    $('cancel-delete-inventory').focus();
  };
  $('cancel-delete-inventory').onclick = () => $('delete-inventory-dialog').close();
  $('delete-inventory-dialog').addEventListener('cancel', event => { if (inventoryDeletionPending) event.preventDefault(); });
  $('confirm-delete-inventory').onclick = async () => {
    if (!deletingInventory || inventoryDeletionPending) return;
    inventoryDeletionPending = true;
    $('confirm-delete-inventory').disabled = true;
    $('cancel-delete-inventory').disabled = true;
    $('delete-inventory-error').hidden = true;
    try {
      await Promise.all([...pendingConfirmations.values()]);
      await api(`/api/equipment/inventories/${deletingInventory.id}`, 'DELETE', {name:deletingInventory.name});
      importReports.delete(deletingInventory.id); crossChecks.delete(deletingInventory.id);
      resetEquipmentFilters(true);
      $('delete-inventory-dialog').close();
      await loadEquipment();
      toast('Inventory deleted.');
    } catch(error) {
      $('delete-inventory-error').textContent = error.message;
      $('delete-inventory-error').hidden = false;
    } finally {
      inventoryDeletionPending = false;
      $('confirm-delete-inventory').disabled = false;
      $('cancel-delete-inventory').disabled = false;
    }
  };
  for (const id of ['close-equipment-inventory','cancel-equipment-inventory']) $(id).onclick = () => $('equipment-inventory-dialog').close();
  $('equipment-inventory-form').onsubmit = async event => {
    event.preventDefault(); $('save-equipment-inventory').disabled = true;
    $('equipment-inventory-form-error').hidden = true;
    try {
      if (!renamingInventoryId) {const name=$('equipment-inventory-name').value.trim();if(!name)throw new Error('Enter an inventory name.');$('equipment-inventory-dialog').close();openColumns({newName:name,template:$('equipment-template').value});return;}
      const inventory = await api(renamingInventoryId ? `/api/equipment/inventories/${renamingInventoryId}` : '/api/equipment/inventories', renamingInventoryId ? 'PUT' : 'POST', {name:$('equipment-inventory-name').value});
      $('equipment-inventory-dialog').close();
      await loadEquipment(inventory.id);
      toast(renamingInventoryId ? 'Inventory renamed.' : 'Inventory created. Import a file or add items.');
    } catch(error) { $('equipment-inventory-form-error').textContent = error.message; $('equipment-inventory-form-error').hidden = false; }
    finally { $('save-equipment-inventory').disabled = false; }
  };
  $('equipment-import').onclick = async () => {try{await inventoryTemplatesReady;openColumns({importing:true});}catch(error){toast(error.message);}};
  $('equipment-show-zero').onchange=renderEquipment;
  for (const id of ['equipment-search','equipment-location-filter','equipment-review-filter']) $(id).addEventListener(id.endsWith('search') ? 'input' : 'change', renderEquipment);
  for (const [value, text] of [['','All items'], ['found','Located'], ['pending','Not located']]) {
    const button = element('button', 'choice-button', text); button.type = 'button';
    button.dataset.value = value; button.setAttribute('aria-pressed', String(value === ''));
    button.onclick = () => {
      $('equipment-status-filter').value = value;
      $('equipment-status-buttons').querySelectorAll('button').forEach(choice => choice.setAttribute('aria-pressed', String(choice === button)));
      renderEquipment();
    };
    $('equipment-status-buttons').append(button);
  }
  $('equipment-clear').onclick = () => {
    $('equipment-search').value = '';
    $('equipment-search').focus();
    renderEquipment();
  };
  $('cancel-equipment-delete').onclick = () => $('equipment-delete-dialog').close();
  $('confirm-equipment-delete').onclick = async () => {
    $('confirm-equipment-delete').disabled = true;
    try { await api(`/api/equipment/${deletingItem.id}`, 'DELETE', {inventory_id:deletingItem.inventory_id}); $('equipment-delete-dialog').close(); toast('Equipment deleted.'); await loadEquipment(); }
    catch(error) { $('equipment-delete-error').textContent = error.message; $('equipment-delete-error').hidden = false; }
    finally { $('confirm-equipment-delete').disabled = false; }
  };
  function renderCrossCheck() {
    const report = crossChecks.get(inventoryId);
    $('equipment-reconciliation').hidden = !report;
    if (!report) return;
    const names = {matched:'Matched', needs_review:'Needs review', different:'Differences', missing:'Missing', ambiguous:'Ambiguous'};
    $('equipment-reconciliation-summary').textContent = `${report.filename} · ${report.source_rows} source rows · ${report.saved_rows} saved records · ` + Object.entries(names).map(([key,label]) => `${label}: ${report.summary[key]}`).join(' · ') + ` · ${report.extra_records.length} saved records without a unique source match`;
    const nodes = report.sheet_errors.map(error => element('p', 'error', `${error.sheet}: ${error.error}`));
    const groups = new Map();
    report.rows.forEach(row => { const key = row.record.location || row.sheet || 'Unassigned'; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); });
    for (const [location, rows] of groups) {
      const group = element('details', 'cross-check-location');
      group.append(element('summary', '', `${location} · ${rows.length} source rows · ${rows.filter(row => row.status !== 'matched').length} to review`));
      const list = element('ul');
      rows.forEach(row => {
        const item = element('li');
        const title = `${names[row.status]} · ${row.sheet || 'CSV'} row ${row.row_number} · ${inventoryValue(row.record,layout().primary_search) || row.record.serial_number || row.record.model || row.record.description || row.record.brand || 'Unnamed'}`;
        item.append(element('strong', '', title));
        const detail = [...row.issues, ...row.differences.map(d => `${d.field}: original “${d.original}”; saved “${d.saved ?? 'blank'}”`)];
        if (detail.length) item.append(element('p', 'inventory-flags', detail.join(' · ')));
        if (row.saved_id) {
          const edit = element('button', 'quiet', 'Open saved item'); edit.type = 'button';
          edit.onclick = () => { const found = items.find(item => item.id === row.saved_id); if (found) openEquipment(found); else toast('Refresh and run the cross-check again.'); };
          item.append(edit);
        }
        list.append(item);
      });
      group.append(list); nodes.push(group);
    }
    if (report.extra_records.length) {
      const extra = element('details', 'cross-check-location'); extra.append(element('summary', '', 'Saved records without a unique source match'));
      const list = element('ul'); report.extra_records.forEach(item => list.append(element('li', '', `ID ${item.id} · ${item.serial_number || item.model || item.description || item.brand} · ${item.location}`))); extra.append(list); nodes.push(extra);
    }
    $('equipment-reconciliation-rows').replaceChildren(...nodes);
  }
  $('equipment-cross-check').onclick = () => $('equipment-original-file').click();
  $('equipment-original-file').onchange = async event => {
    const file = event.target.files[0]; if (!file) return;
    $('equipment-cross-check').disabled = true;
    try {
      await inventoryLoad; const inventory = currentInventory();
      if (file.size > 5000000) throw new Error('Choose a file smaller than 5 MB.');
      const content = await new Promise((resolve,reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = () => reject(new Error('Could not read file.')); reader.readAsDataURL(file); });
      const report = await api('/api/equipment/reconcile', 'POST', {filename:file.name, content, inventory_id:inventory.id});
      crossChecks.set(inventory.id, report); renderCrossCheck(); toast('Original file cross-check complete.');
    } catch(error) { toast('Cross-check failed: ' + error.message); }
    finally { event.target.value = ''; $('equipment-cross-check').disabled = false; }
  };
  $('equipment-reconciliation-download').onclick = () => {
    const report = crossChecks.get(inventoryId); if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report,null,2)], {type:'application/json'}));
    const link = element('a'); link.href=url; link.download='inventory-cross-check.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
  };
  $('cancel-equipment-record-review').onclick = () => $('equipment-record-review-dialog').close();
  window.equipmentUI = {profile:()=>layout(),importReport:(id, report) => { importReports.set(id, report); renderEquipment(); },load:loadEquipment, open:openEquipment,
    currentInventory,
    waitUntilReady:async () => { await inventoryLoad; return currentInventory(); },
    flush:() => Promise.all([...pendingConfirmations.values()]),
    exportData:scope => {
      const inventory = currentInventory();
      const records = scope === 'all' ? items : scope === 'selected' ? visibleItems.filter(item => selectedItems.has(item.id)) : visibleItems;
      return {inventory_id:inventory.id, ids:records.map(item => item.id), name:inventory.name};
    }};
})();
