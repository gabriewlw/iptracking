"""Desktop inventory templates: creation, matching, batch review and stock edits."""
import json
import shutil
import sys
import tempfile
import threading
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import app
from playwright.sync_api import sync_playwright

with tempfile.TemporaryDirectory() as temporary:
    app.DB_PATH=Path(temporary)/'inventory.sqlite3'
    server=app.ThreadingHTTPServer(('127.0.0.1',0),app.Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path=shutil.which('chromium') or None)
            page=browser.new_page(viewport={'width':1600,'height':1000});errors=[]
            page.on('pageerror',lambda error:errors.append(str(error)))
            page.goto(f'http://127.0.0.1:{server.server_port}/inventory')
            page.wait_for_function("() => !document.getElementById('equipment-inventory-select').disabled")
            page.locator('#new-equipment-inventory').click()
            page.locator('#equipment-inventory-dialog').wait_for(state='visible')
            assert page.locator('#equipment-template option').count()==11
            page.locator('#equipment-inventory-name').fill('Spare TVs onboard')
            page.locator('#equipment-template').select_option('tv')
            page.locator('#save-equipment-inventory').click()
            page.locator('#inventory-columns-dialog').wait_for(state='visible')
            assert page.locator('#inventory-column-list .inventory-column-editor').count()==7
            assert page.locator('#inventory-column-preset').input_value()=='tv'
            # File picker triggered after create; cancel and use an in-memory CSV.
            with page.expect_file_chooser():page.locator('#save-inventory-columns').click()
            page.locator('#inventory-columns-dialog').wait_for(state='hidden')
            page.locator('#import-file').set_input_files({'name':'tvs.csv','mimeType':'text/csv','buffer':b'Brand,Model,Deck 6,Deck 2 Port,Deck 2 Stbd,Notes\nSony,X,2,3,0,test\nLG,Y,0,0,0,zero\nLG,Z,1,,0,check\n'})
            page.wait_for_function("() => !document.getElementById('confirm-import').disabled")
            assert page.locator('#map-total_count').count()==0
            assert page.locator('#map-deck_6').input_value()=='2'
            assert '1 zero-stock rows' in page.locator('#equipment-import-audit').inner_text()
            page.locator('#confirm-import').click()
            page.locator('#inventory-import-review').wait_for(state='visible')
            assert page.locator('#inventory-import-review-title').inner_text()=='Review TV models'
            assert page.locator('#inventory-import-review-rows tr').count()==1
            page.get_by_label('Deck 2 Port, row 4',exact=True).select_option('2')
            assert page.get_by_label('Total count, row 4',exact=True).input_value()=='3'
            assert page.get_by_label('Total count, row 4',exact=True).get_attribute('readonly') is not None
            page.get_by_role('checkbox',name='Select row 4',exact=True).check()
            page.locator('#inventory-import-review-save').click()
            page.locator('#inventory-import-review').wait_for(state='hidden')
            page.wait_for_function("() => document.getElementById('equipment-records').textContent==='2'")
            assert page.locator('#equipment-units').inner_text()=='8'
            assert not page.locator('#equipment-locations').is_visible()
            assert not page.locator('.equipment-status-group').is_visible()
            assert page.evaluate("() => [...document.querySelectorAll('#equipment-rows tr')].every(row=>Math.abs(row.getBoundingClientRect().height-47)<1)")
            assert page.locator('#equipment-rows tr').count()==2
            page.locator('#add-device').click()
            page.locator('#equipment-brand').fill('Samsung');page.locator('#equipment-model').fill('Found TV')
            page.locator('#equipment-form').get_by_label('Deck 6',exact=True).select_option('1')
            assert page.locator('#equipment-form').get_by_label('Total count',exact=True).input_value()=='1'
            page.locator('#save-equipment').click();page.locator('#equipment-dialog').wait_for(state='hidden')
            page.wait_for_function("() => document.getElementById('equipment-records').textContent==='3'")
            page.get_by_role('button',name='Edit equipment Found TV',exact=True).click()
            page.locator('#equipment-form').get_by_label('Deck 6',exact=True).select_option('0');page.locator('#save-equipment').click()
            page.locator('#equipment-dialog').wait_for(state='hidden')
            page.wait_for_function("() => document.querySelectorAll('#equipment-rows tr').length===2")
            page.locator('#equipment-show-zero').check()
            page.wait_for_function("() => document.querySelectorAll('#equipment-rows tr').length===3")
            # Change inventory and ensure static/custom fields still rebuild correctly.
            page.locator('#new-equipment-inventory').click();page.locator('#equipment-inventory-name').fill('Scala screens')
            page.locator('#equipment-template').select_option('scala');page.locator('#save-equipment-inventory').click()
            assert page.get_by_label('Column 1 name',exact=True).input_value()=='Scala ID'
            with page.expect_file_chooser():page.locator('#save-inventory-columns').click()
            page.locator('#inventory-columns-dialog').wait_for(state='hidden')
            page.locator('#add-device').click()
            assert not page.locator('#equipment-serial_number').is_visible()
            page.get_by_label('Scala ID',exact=True).fill('SC-1');page.locator('#equipment-location').fill('Lobby')
            page.get_by_label('Monitor Brand',exact=True).fill('LG');page.get_by_label('Monitor Model',exact=True).fill('55')
            page.get_by_label('Size (inch)',exact=True).fill('55');page.get_by_role('button',name='Vertical',exact=True).click()
            page.locator('#save-equipment').click();page.locator('#equipment-dialog').wait_for(state='hidden')
            page.wait_for_function("() => document.getElementById('equipment-records').textContent==='1'")
            assert 'Serial Number' not in page.locator('#equipment-table').inner_text()
            assert page.evaluate("() => [...document.querySelectorAll('#equipment-rows tr')].every(row=>Math.abs(row.getBoundingClientRect().height-47)<1)")
            assert 'across' not in page.locator('#workspace-page-summary').inner_text()
            assert page.locator('#equipment-location-buttons button').count()==0
            page.locator('#new-equipment-inventory').click();page.locator('#equipment-inventory-name').fill('Locker spares')
            page.locator('#equipment-template').select_option('spare_parts');page.locator('#save-equipment-inventory').click()
            with page.expect_file_chooser():page.locator('#save-inventory-columns').click()
            page.locator('#inventory-columns-dialog').wait_for(state='hidden')
            page.locator('#import-file').set_input_files({'name':'parts.csv','mimeType':'text/csv','buffer':b'Description,Brand,Model,Serial Number,Quantity,Location,Notes\nCable,Sony,X,S1,1,Locker A,note\nCable,,X,S2,2,Locker A,note\nCable,Sony,X,S3,1,Locker B,note\n'})
            page.wait_for_function("() => !document.getElementById('confirm-import').disabled")
            page.locator('#confirm-import').click();page.locator('#inventory-import-review').wait_for(state='visible')
            assert page.get_by_label('Location, row 3',exact=True).locator('option').all_text_contents()==['Leave blank','Locker A','Locker B']
            assert page.get_by_label('Quantity, row 3',exact=True).locator('option').count()==51
            page.get_by_label('Brand, row 3',exact=True).fill('Sony');page.get_by_role('checkbox',name='Select row 3',exact=True).check()
            page.locator('#inventory-import-review-save').click();page.locator('#inventory-import-review').wait_for(state='hidden')
            page.wait_for_function("() => document.getElementById('equipment-records').textContent==='3'")
            assert page.locator('#equipment-location-buttons button').count()==2
            located=page.locator('#equipment-rows .ip-confirm').first
            assert located.inner_text()=='Not located';located.click()
            page.wait_for_function("() => document.querySelector('#equipment-rows .ip-confirm').textContent==='Located'")
            page.get_by_role('button',name='Edit equipment S1',exact=True).click()
            assert page.locator('#equipment-quantity').evaluate('(node)=>node.tagName')=='SELECT'
            page.locator('#equipment-form').get_by_role('button',name='New location',exact=True).click()
            page.get_by_label('New storage location',exact=True).fill('Locker C')
            page.locator('#equipment-form').get_by_role('button',name='Add location',exact=True).click()
            assert page.locator('#equipment-location').input_value()=='Locker C'
            page.locator('#save-equipment').click();page.locator('#equipment-dialog').wait_for(state='hidden')
            page.wait_for_function("() => [...document.querySelectorAll('#equipment-location-buttons button')].some(button=>button.textContent==='Locker C')")
            page.screenshot(path=str(Path(app.__file__).parent/'work/template-desktop.png'),full_page=True)
            assert page.evaluate("() => [...document.querySelectorAll('#equipment-rows tr')].every(row=>Math.abs(row.getBoundingClientRect().height-47)<1)")
            assert not errors,errors
            browser.close()
    finally:server.shutdown();server.server_close()
print('Inventory template browser checks passed')
