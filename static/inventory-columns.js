let inventoryTemplates=[];
const inventoryTemplatesReady=fetch('/inventory-templates.json').then(response=>{if(!response.ok)throw new Error('Could not load inventory templates.');return response.json();}).then(templates=>{inventoryTemplates=templates;return templates;});
inventoryTemplatesReady.catch(()=>{});
const defaultInventoryLayout = {"columns": [{"key": "description", "label": "Item", "type": "text", "important": true, "filter": "none", "options": []}, {"key": "brand", "label": "Brand", "type": "text", "important": true, "filter": "none", "options": []}, {"key": "model", "label": "Model", "type": "text", "important": true, "filter": "none", "options": []}, {"key": "serial_number", "label": "Serial number", "type": "text", "important": true, "filter": "none", "options": []}, {"key": "quantity", "label": "Quantity", "type": "text", "important": true, "filter": "none", "options": []}, {"key": "location", "label": "Location", "type": "text", "important": true, "filter": "buttons", "options": []}, {"key": "notes", "label": "Notes", "type": "text", "important": false, "filter": "none", "options": []}], "primary_search": "serial_number", "identifier": ""};
const scalaInventoryLayout = {"columns": [{"key": "asset_id", "label": "ID", "type": "text", "important": true, "filter": "none", "options": []}, {"key": "location", "label": "Location", "type": "text", "important": true, "filter": "none", "options": []}, {"key": "monitor_model", "label": "Monitor model", "type": "text", "important": true, "filter": "dropdown", "options": []}, {"key": "orientation", "label": "Orientation", "type": "buttons", "important": false, "filter": "dropdown", "options": ["Vertical", "Horizontal"]}, {"key": "notes", "label": "Notes", "type": "text", "important": false, "filter": "none", "options": []}], "primary_search": "asset_id", "identifier": "asset_id", "show_status": false};
const inventoryBaseFields = new Set(['description','brand','model','serial_number','quantity','location','notes']);
const inventoryValue = (row,key) => inventoryBaseFields.has(key) ? row[key] ?? '' : row.custom_values?.[key] ?? '';
function inventoryInput(column,value = '', {allowClear = true, locations = []} = {}) {
  // Orientation stays easy to set later, including inventories that used a text column.
  if (column.key === 'orientation') {
    column = {...column,type:'buttons',options:column.options.length ? column.options : ['Vertical','Horizontal']};
    allowClear = false;
  }
  if(column.type==='count')column={...column,type:'select',options:Array.from({length:51-(column.minimum ?? 1)},(_,index)=>String(index+(column.minimum ?? 1)))};
  if(column.type==='location')column={...column,type:'select',options:[...new Set([...locations,String(value || '')].filter(Boolean))].sort()};
  const wrapper = element('div', 'inventory-value-input');
  const control = element(column.type === 'select' ? 'select' : column.type==='text'&&['notes','description'].includes(column.key) ? 'textarea' : 'input');
  control.dataset.columnKey = column.key; control.setAttribute('aria-label',column.label);
  control.value = value; control.maxLength = ['notes','description'].includes(column.key) ? 2000 : 120;
  if (column.type === 'select') {
    control.append(new Option('Leave blank',''),...column.options.map(value => new Option(value,value)));
    if(value&&!column.options.includes(value))control.append(new Option('Review: '+value,value));
    control.value = value;
  } else if (column.type === 'checkbox') {
    control.type='hidden';
    const label=element('label','inventory-checkbox-control');
    const check=element('input');check.type='checkbox';check.checked=value==='Yes';check.indeterminate=!value;check.setAttribute('aria-label',column.label);
    const text=element('span','',value || 'Unknown');
    check.onchange=()=>{control.value=check.checked?'Yes':'No';text.textContent=control.value;control.dispatchEvent(new Event('change',{bubbles:true}));};
    const clear=element('button','quiet','Clear');clear.type='button';clear.onclick=()=>{control.value='';check.checked=false;check.indeterminate=true;text.textContent='Unknown';control.dispatchEvent(new Event('change',{bubbles:true}));};
    label.append(check,text);wrapper.append(label);if(allowClear)wrapper.append(clear);
  } else if (column.type === 'buttons') {
    control.type='hidden';const group=element('div','choice-buttons');group.setAttribute('role','group');group.setAttribute('aria-label',column.label);
    (allowClear ? ['',...column.options] : column.options).forEach(value=>{const button=element('button','choice-button',value || 'Clear');button.type='button';button.dataset.value=value;button.setAttribute('aria-pressed',String(value===control.value));button.onclick=()=>{control.value=value;group.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));control.dispatchEvent(new Event('change',{bubbles:true}));};group.append(button);});wrapper.append(group);
  } else { control.type=column.key==='quantity'?'number':'text';if(column.key==='quantity'){control.min='0';control.max='1000000';} }
  if(column.type==='calculated'){control.readOnly=true;control.setAttribute('aria-description','Calculated from deck counts');wrapper.classList.add('inventory-calculated');}
  if(control.tagName==='TEXTAREA')control.rows=1;
  wrapper.append(control);return {wrapper,control};
}

function inventoryCalculate(row,profile) {
  const result={...row,custom_values:{...row.custom_values}};
  profile.columns.filter(col=>col.type==='calculated').forEach(col=>{
    const values=col.sources.map(key=>String(inventoryValue(result,key)).trim());
    result.custom_values[col.key]=values.every(value=>/^\d+$/.test(value)) ? String(values.reduce((sum,value)=>sum+Number(value),0)) : '';
  });
  if(profile.stock_mode==='tv_counts')result.quantity=result.custom_values.total_count===''?null:Number(result.custom_values.total_count);
  return result;
}
