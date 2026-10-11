"""Inventory-specific columns, filters and bounded custom record values."""
import re

BASE_FIELDS = ('description','brand','model','serial_number','quantity','location','notes')
LABELS = {'description':'Item','brand':'Brand','model':'Model','serial_number':'Serial number','quantity':'Quantity','location':'Location','notes':'Notes'}
DEFAULT_PROFILE = {'columns':[{'key':key,'label':LABELS[key],'type':'text','important':key!='notes','filter':'buttons' if key=='location' else 'none','options':[]} for key in BASE_FIELDS], 'primary_search':'serial_number', 'identifier':''}
SCALA_PROFILE = {'columns':[
    {'key':'asset_id','label':'ID','type':'text','important':True,'filter':'none','options':[]},
    {'key':'location','label':'Location','type':'text','important':True,'filter':'none','options':[]},
    {'key':'monitor_model','label':'Monitor model','type':'text','important':True,'filter':'dropdown','options':[]},
    {'key':'orientation','label':'Orientation','type':'buttons','important':False,'filter':'dropdown','options':['Vertical','Horizontal']},
    {'key':'notes','label':'Notes','type':'text','important':False,'filter':'none','options':[]}], 'primary_search':'asset_id', 'identifier':'asset_id', 'show_status':False}


def validate_profile(value):
    if not isinstance(value,dict) or not isinstance(value.get('columns'),list) or not 1 <= len(value['columns']) <= 16:
        raise ValueError('Choose between 1 and 16 inventory columns.')
    columns, keys, labels = [], set(), set()
    for col in value['columns']:
        if not isinstance(col,dict):
            raise ValueError('Each column needs a name and settings.')
        key,label = col.get('key'),col.get('label')
        if not isinstance(key,str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,47}',key) or key in ('id','inventory_id','custom_values','item_confirmed','data_checked','updated_at') or key in keys:
            raise ValueError('Column keys must be distinct, valid names.')
        if not isinstance(label,str) or not label.strip() or len(label.strip())>120 or label.strip().casefold() in labels:
            raise ValueError('Give each column a different name, from 1 to 120 characters.')
        kind, filtering, options = col.get('type','text'), col.get('filter','none'),col.get('options',[])
        if kind not in ('text','select','checkbox','buttons','count','location','calculated') or filtering not in ('none','dropdown','buttons') or type(col.get('important',False)) is not bool:
            raise ValueError('Choose valid column types, importance and filters.')
        if not isinstance(options,list) or len(options)>50 or any(not isinstance(opt,str) or not opt.strip() or len(opt)>120 for opt in options):
            raise ValueError('Choose up to 50 valid choices for a column.')
        options=[opt.strip() for opt in options]
        if len({opt.casefold() for opt in options})!=len(options) or (kind in ('select','buttons') and not options):
            raise ValueError('Choice columns need distinct nonempty choices.')
        if kind=='location' and key!='location':
            raise ValueError('Location choices must use the Location field.')
        if key in BASE_FIELDS and kind not in ('text','count','location'):
            raise ValueError('Built-in fields use text inputs; add a custom column for choices.')
        column=dict(key=key,label=label.strip(),type=kind,important=col.get('important',False),filter=filtering,options=options)
        if kind=='count':
            if key in BASE_FIELDS and key!='quantity':raise ValueError('Only Quantity uses a built-in count dropdown.')
            minimum=col.get('minimum',1)
            if type(minimum) is not int or minimum not in (0,1):raise ValueError('Count dropdowns start at 0 or 1.')
            column['minimum']=minimum
        if kind=='calculated':
            sources=col.get('sources')
            if key in BASE_FIELDS or not isinstance(sources,list) or not sources or len(sources)>16 or any(not isinstance(source,str) for source in sources) or len(set(sources))!=len(sources):raise ValueError('Choose valid count columns to sum.')
            column['sources']=sources
        if 'aliases' in col:
            aliases=col['aliases']
            if not isinstance(aliases,list) or len(aliases)>20 or any(not isinstance(alias,str) or not alias.strip() or len(alias)>120 for alias in aliases):raise ValueError('Choose valid source column names.')
            column['aliases']=[alias.strip() for alias in aliases]
        columns.append(column)
        keys.add(key);labels.add(label.strip().casefold())
    definitions={col['key']:col for col in columns}
    for col in columns:
        if col['type']=='calculated' and any(source not in definitions or source in BASE_FIELDS or definitions[source]['type']!='count' for source in col['sources']):
            raise ValueError('Total counts must sum existing count dropdown columns.')
    primary,identifier=value.get('primary_search',columns[0]['key']),value.get('identifier','')
    if primary not in keys or (identifier and identifier not in keys):
        raise ValueError('Choose search and identifier columns from this inventory.')
    if identifier in ('location','quantity','notes'):
        raise ValueError('Choose an item ID or serial number as the identifier.')
    result = dict(columns=columns,primary_search=primary,identifier=identifier)
    if 'show_status' in value:
        if type(value['show_status']) is not bool:
            raise ValueError('Choose whether to show location status.')
        result['show_status'] = value['show_status']
    for key,allowed in {'location_role':('storage','geographic','none'),'stock_mode':('tv_counts',)}.items():
        if key in value:
            if value[key] not in allowed:raise ValueError('Invalid inventory template settings.')
            result[key]=value[key]
    if 'template' in value:
        if not isinstance(value['template'],str) or not re.fullmatch(r'[a-z_]{1,30}',value['template']):raise ValueError('Invalid template name.')
        result['template']=value['template']
    if result.get('stock_mode')=='tv_counts' and (not {'brand','model','total_count'}.issubset(keys) or definitions.get('total_count',{}).get('type')!='calculated'):raise ValueError('TV inventories need Brand, Model and Total count. Remove the TV total before changing these columns.')
    return result


def custom_values(value,profile):
    if value is None:value={}
    if not isinstance(value,dict) or len(value)>32:
        raise ValueError('Custom column values must be an object.')
    definitions={col['key']:col for col in profile['columns'] if col['key'] not in BASE_FIELDS}
    # Retain values for columns hidden/removed from the layout, preventing data loss.
    result={}
    for key,raw in value.items():
        if not isinstance(key,str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,47}',key) or key in BASE_FIELDS or key in ('id','inventory_id','custom_values','item_confirmed','data_checked','updated_at'):
            raise ValueError('Invalid custom column key.')
        if raw is None:raw=''
        if not isinstance(raw,str) or len(raw.strip())>2000:
            raise ValueError('Custom values must be text, up to 2,000 characters.')
        raw=raw.strip();col=definitions.get(key)
        if col and col['type']=='checkbox' and raw:
            choices={'yes':'Yes','true':'Yes','1':'Yes','checked':'Yes','no':'No','false':'No','0':'No','unchecked':'No'}
            if raw.casefold() not in choices:
                raise ValueError(f'{col["label"]}: use Yes or No, or leave blank.')
            raw=choices[raw.casefold()]
        if col and col['type'] in ('select','buttons') and raw:
            choices={opt.casefold():opt for opt in col['options']}
            if key=='orientation':
                raw={'portrait':'Vertical','landscape':'Horizontal'}.get(raw.casefold(),raw)
            if raw.casefold() not in choices:
                raise ValueError(f'{col["label"]}: choose one of {", ".join(col["options"])} or leave blank.')
            raw=choices[raw.casefold()]
        if col and col['type']=='count' and raw:
            if not re.fullmatch(r'\d+',raw) or not col.get('minimum',1)<=int(raw)<=50:raise ValueError(f'{col["label"]}: choose a whole number from {col.get("minimum",1)} to 50.')
            raw=str(int(raw))
        result[key]=raw
    for col in definitions.values():
        if col['type']=='calculated':
            counts=[result.get(source,'') for source in col['sources']]
            result[col['key']]=str(sum(int(count) for count in counts)) if all(count!='' for count in counts) else ''
    return result


def column_value(row,key):
    return row.get(key,'') if key in BASE_FIELDS else row.get('custom_values',{}).get(key,'')


def profile_identifier(row,profile):
    if profile.get('stock_mode')=='tv_counts':
        return ('tv',row['brand'].strip().casefold(),row['model'].strip().casefold()) if row.get('brand') and row.get('model') else None
    value=column_value(row,profile['identifier']) if profile.get('identifier') else ''
    return str(value).strip().casefold() if value not in ('',None) else None


def normalize_template_row(row, profile):
    """Derive trusted totals and validate the built-in dropdown values."""
    for col in profile['columns']:
        if col['type']=='count' and col['key'] in BASE_FIELDS:
            value=row.get(col['key'])
            if value not in ('',None) and not col.get('minimum',1)<=int(value)<=50:
                raise ValueError(f'{col["label"]}: choose a whole number from {col.get("minimum",1)} to 50.')
    if profile.get('stock_mode')=='tv_counts':
        total=row['custom_values'].get('total_count','')
        row['quantity']=int(total) if total else None
    return row
