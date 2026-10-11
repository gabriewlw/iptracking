"""Template constraints, trusted stock totals and reconciliation."""
import base64
import copy
import json
from pathlib import Path
import unittest
import app
import test_app
from inventory_profiles import validate_profile
from reconciliation import reconcile_profile

TEMPLATES=json.loads((Path(app.__file__).parent/'static/inventory-templates.json').read_text())

class InventoryTemplateTests(unittest.TestCase):
    setUpClass=test_app.AppTests.__dict__['setUpClass']
    tearDownClass=test_app.AppTests.__dict__['tearDownClass']
    setUp=test_app.AppTests.setUp
    tearDown=test_app.AppTests.tearDown
    request=test_app.AppTests.request

    def create(self,kind):
        template=next(t for t in TEMPLATES if t['id']==kind)
        return app.save_equipment_inventory(dict(name=template['name'],layout=template['layout']))

    def tv(self,inventory,model='X',counts=('2','3','0')):
        return dict(inventory_id=inventory['id'],brand='Sony',model=model,custom_values=dict(zip(('deck_6','deck_2_port','deck_2_stbd'),counts),total_count='999'))

    def test_every_template_roundtrips_and_is_editable(self):
        self.assertEqual(len(TEMPLATES),10)
        for template in TEMPLATES:
            layout=copy.deepcopy(template['layout']);layout['columns'][0]['label']='Custom name'
            saved=app.save_equipment_inventory(dict(name=template['name'],layout=layout))
            self.assertEqual(saved['layout']['columns'][0]['label'],'Custom name')
        status,data=self.request('/inventory-templates.json')
        self.assertEqual(status,200);self.assertEqual(data,TEMPLATES)

    def test_tv_totals_are_derived_and_editable_with_unique_model(self):
        inventory=self.create('tv');row=app.save_equipment(self.tv(inventory))
        self.assertEqual(row['quantity'],5);self.assertEqual(row['custom_values']['total_count'],'5')
        updated=app.save_equipment(self.tv(inventory,counts=('2','1','4')),row['id'])
        self.assertEqual(updated['quantity'],7)
        with self.assertRaises(ValueError):app.save_equipment(self.tv(inventory))
        other=app.save_equipment(dict(self.tv(inventory),brand='LG'))
        self.assertEqual(other['quantity'],5)
        self.assertEqual(self.request('/api/equipment','POST',self.tv(inventory,'BAD',('51','0','0')))[0],400)

    def test_zero_stock_skips_import_and_can_be_added_later(self):
        inventory=self.create('tv')
        result=app.import_equipment(dict(version=1,inventory_id=inventory['id'],equipment=[self.tv(inventory,'Zero',('0','0','0')),self.tv(inventory)]))
        self.assertEqual(result,dict(added=1,skipped=1,skipped_zero=1))
        row=app.save_equipment(self.tv(inventory,'Zero',('0','0','0')))
        self.assertEqual(row['quantity'],0)
        self.assertEqual(app.save_equipment(self.tv(inventory,'Zero',('1','0','0')),row['id'])['quantity'],1)

    def test_blank_deck_count_is_unknown_not_zero(self):
        inventory=self.create('tv');row=app.save_equipment(self.tv(inventory,counts=('2','','0')))
        self.assertIsNone(row['quantity']);self.assertEqual(row['custom_values']['total_count'],'')

    def test_tv_crosscheck_handles_totals_zero_rows_and_brands(self):
        inventory=self.create('tv');app.save_equipment(self.tv(inventory));app.save_equipment(dict(self.tv(inventory),brand='LG'))
        raw=b'Brand,Model,Deck 6,Deck 2 Port,Deck 2 Stbd,Notes\nSony,X,2,3,0,\nLG,X,2,3,0,\nSony,Zero,0,0,0,\n'
        report=reconcile_profile(dict(filename='tv.csv',content=base64.b64encode(raw).decode()),app.equipment_inventory(inventory['id']),inventory['layout'])
        self.assertTrue(report['complete']);self.assertEqual(report['summary']['matched'],3)
        self.assertTrue(report['rows'][-1]['skipped_zero']);self.assertEqual(report['extra_records'],[])

    def test_original_tv_total_discrepancy_is_flagged(self):
        inventory=self.create('tv');app.save_equipment(self.tv(inventory))
        raw=b'Brand,Model,Deck 6,Deck 2 Port,Deck 2 Stbd,Total count\nSony,X,2,3,0,9\n'
        report=reconcile_profile(dict(filename='tv.csv',content=base64.b64encode(raw).decode()),app.equipment_inventory(inventory['id']),inventory['layout'])
        self.assertFalse(report['complete']);self.assertEqual(report['summary']['needs_review'],1)
        self.assertIn('Original Total count: 9; calculated: 5',report['rows'][0]['issues'])

    def test_spare_quantity_limits_and_scala_location_count(self):
        inventory=self.create('spare_parts')
        self.assertEqual(self.request('/api/equipment','POST',dict(inventory_id=inventory['id'],description='Spare',quantity=51))[0],400)
        app.save_equipment(dict(inventory_id=inventory['id'],description='Spare',quantity=50,location='Locker'))
        scala=self.create('scala');app.save_equipment(dict(inventory_id=scala['id'],location='Lobby',custom_values={'asset_id':'SC1'}))
        self.assertEqual(app.workspace_overview()['inventory_locations'],1)
        self.assertFalse(scala['layout']['show_status'])
        self.assertNotIn('serial_number',[col['key'] for col in scala['layout']['columns']])

    def test_invalid_calculation_is_rejected(self):
        profile=copy.deepcopy(next(t for t in TEMPLATES if t['id']=='tv')['layout'])
        profile['columns'][5]['sources']=['total_count']
        with self.assertRaises(ValueError):validate_profile(profile)
