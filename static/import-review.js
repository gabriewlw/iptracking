/* Inventory import review keeps several editable rows from one location together. */
function reviewEquipmentBatch(entries, index, total, inventory, fields, filename, locations = []) {
  return new Promise(resolve => {
    const dialog = $('inventory-import-review');
    let saving = false, finished = false;
    const outcomes = [];
    $('inventory-import-review-title').textContent = inventory.layout?.stock_mode==='tv_counts'?'Review TV models':`Review ${entries[0].row.location || 'unassigned location'}`;
    $('inventory-import-review-progress').textContent = `${filename} · ${inventory.name} · ${entries[0].locationProgress.split(' · ').slice(0,2).join(' · ')} · ${entries.length} rows on this screen · ${total} source rows`;
    const head = element('tr');
    ['Select / source row', ...fields.map(([key,label]) => label.replace(' (optional)','')+(key==='orientation'?' (optional)':'')), 'Result'].forEach(label => {
      const cell=element('th','',label);cell.scope='col';head.append(cell);
    });
    $('inventory-import-review-head').replaceChildren(head);
    dialog.querySelector('table').style.minWidth=`${380+fields.length*170}px`;
    const states = entries.map(entry => {
      const row=element('tr');row.dataset.sourceRow=entry.number;
      const selection=element('td');
      const label=element('label','batch-row-selection');
      const check=element('input');check.type='checkbox';check.checked=!entry.issues.length;check.setAttribute('aria-label',`Select row ${entry.number}`);
      label.append(check,element('strong','',`Row ${entry.number}`));selection.append(label);
      const flags=element('p','batch-row-flags',entry.issues.join(' · '));flags.hidden=!entry.issues.length;selection.append(flags);row.append(selection);
      const controls=new Map();
      fields.forEach(([key,label]) => {
        const cell=element('td');
        const column=inventory.layout?.columns.find(column=>column.key===key);
        let control;
        if (column) {
          const input=inventoryInput(column,inventoryValue(entry.row,key),{allowClear:key!=='orientation',locations});
          cell.append(input.wrapper);control=input.control;
          input.wrapper.querySelectorAll('button').forEach(button=>button.setAttribute('aria-label',`${button.textContent} for row ${entry.number}`));
        } else {
          control=element(key==='notes'||key==='description'?'textarea':'input');
          control.value=entry.row[key] ?? '';control.maxLength=key==='notes'||key==='description'?2000:120;
          if(control.tagName==='TEXTAREA')control.rows=1;
          if(key==='quantity'){control.type='number';control.min='0';control.max='1000000';}
          cell.append(control);
        }
        control.setAttribute('aria-label',`${label.replace(' (optional)','')}, row ${entry.number}`);
        controls.set(key,control);row.append(cell);
      });
      const calculate=()=>{const values={...entry.row,custom_values:{...entry.row.custom_values}};controls.forEach((input,key)=>{if(inventoryBaseFields.has(key))values[key]=input.value;else values.custom_values[key]=input.value;});const calculated=inventoryCalculate(values,inventory.layout || defaultInventoryLayout);(inventory.layout?.columns || []).filter(col=>col.type==='calculated').forEach(col=>{controls.get(col.key).value=inventoryValue(calculated,col.key);});};
      controls.forEach(control=>control.addEventListener('change',calculate));calculate();
      const status=element('td','batch-row-result','Awaiting review');status.setAttribute('role','status');row.append(status);
      check.onchange=updateSelection;
      return {entry,row,check,flags,controls,status,done:false};
    });
    $('inventory-import-review-rows').replaceChildren(...states.map(state=>state.row));
    function updateSelection() {
      const remaining=states.filter(state=>!state.done),selected=remaining.filter(state=>state.check.checked).length;
      const all=$('inventory-import-review-all');
      all.checked=!!remaining.length&&selected===remaining.length;all.indeterminate=selected>0&&selected<remaining.length;
      all.disabled=saving||!remaining.length;
      $('inventory-import-review-save').disabled=saving||!selected;
      $('inventory-import-review-skip').disabled=saving||!selected;
      $('inventory-import-review-save').textContent=`Import selected (${selected})`;
      $('inventory-import-review-count').textContent=`${states.filter(state=>state.done).length} of ${states.length} rows finished · ${selected} selected`;
      $('inventory-import-review-stop').disabled=saving;
      $('inventory-import-review-close').disabled=saving;
    }
    function finish(stopped=false) {
      if(saving||finished)return;
      finished=true;dialog.close();resolve({outcomes,stopped});
    }
    function editedRow(state) {
      const row={...state.entry.row,custom_values:{...state.entry.row.custom_values}};
      state.controls.forEach((control,key)=>{if(inventoryBaseFields.has(key))row[key]=control.value.trim();else row.custom_values[key]=control.value.trim();});
      row.location=cleanVenue(row.location);
      const calculated=inventoryCalculate(row,inventory.layout || defaultInventoryLayout);Object.assign(row,calculated);
      state.entry.row=row;
      state.entry.issues=[...equipmentIssues(row),...state.entry.issues.filter(issue=>issue.startsWith('Repeated '))];
      state.flags.textContent=state.entry.issues.join(' · ');state.flags.hidden=!state.entry.issues.length;
      return row;
    }
    function complete(state,result) {
      state.done=true;state.check.checked=false;
      state.row.querySelectorAll('input,select,textarea,button').forEach(control=>{control.disabled=true;});
      state.status.classList.remove('error');
      state.status.textContent=result.skippedRow?'Skipped by you':result.skipped?'Already saved · skipped':'Imported';
      state.row.classList.add('batch-row-done');outcomes.push({entry:state.entry,result});
    }
    $('inventory-import-review-all').onchange=event=>{states.filter(state=>!state.done).forEach(state=>{state.check.checked=event.target.checked;});updateSelection();};
    $('inventory-import-review-save').onclick=async()=>{
      if(saving)return;
      const selected=states.filter(state=>!state.done&&state.check.checked);
      saving=true;dialog.querySelectorAll('input,select,textarea,button').forEach(control=>{control.disabled=true;});updateSelection();
      try {
        for(const state of selected) {
          const row=editedRow(state);
          if(inventory.layout?.stock_mode==='tv_counts'&&row.quantity===0){complete(state,{skippedRow:true});state.status.textContent='Zero total · skipped';continue;}
          if(!meaningfulImportRow(row)){complete(state,{skippedRow:true});continue;}
          state.status.textContent='Importing…';
          try {
            const result=await api('/api/equipment/import','POST',{version:1,inventory_id:inventory.id,equipment:[row]});
            complete(state,result);
          } catch(error) {
            state.status.textContent=error.message.replace('Nothing was imported.','This row was not imported.');state.status.classList.add('error');
          }
        }
      } finally {
        saving=false;states.filter(state=>!state.done).forEach(state=>state.row.querySelectorAll('input,select,textarea,button').forEach(control=>{control.disabled=false;if(control.dataset.columnKey && inventory.layout?.columns.some(col=>col.key===control.dataset.columnKey&&col.type==='calculated'))control.readOnly=true;}));
        updateSelection();if(states.every(state=>state.done))finish();
      }
    };
    $('inventory-import-review-skip').onclick=()=>{
      if(saving)return;
      states.filter(state=>!state.done&&state.check.checked).forEach(state=>{editedRow(state);complete(state,{skippedRow:true});});
      updateSelection();if(states.every(state=>state.done))finish();
    };
    $('inventory-import-review-close').onclick=$('inventory-import-review-stop').onclick=()=>finish(true);
    dialog.oncancel=event=>{event.preventDefault();finish(true);};
    updateSelection();dialog.showModal();$('inventory-import-review-all').focus();
  });
}
