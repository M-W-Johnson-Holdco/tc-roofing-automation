import os

with open('index.template.html', 'r', encoding='utf-8') as f:
    content = f.read()

keys = [
    'RC_CLIENT_ID','RC_CLIENT_SECRET','RC_JWT','RC_FROM',
    'GS_CLIENT_ID','GS_CLIENT_SECRET','GS_REFRESH_TOKEN','GS_SHEET_ID','GS_SHEET_NAME',
    'AL_API_KEY','GCAL_CLIENT_ID','GCAL_CLIENT_SECRET','GCAL_REFRESH_TOKEN',
    'GCAL_CALENDAR_DEFAULT','GCAL_ID_RE_INSPECTION','GCAL_ID_INSURANCE_ADJUSTMENT',
    'GCAL_ID_INTERIOR_INS_ADJ','GCAL_ID_FORENSIC','GCAL_ID_ENGINEER','GCAL_ID_ON_ROOF',
    'GCAL_ID_INTERIOR_INSP','GCAL_ID_SHINGLE_PULL','GCAL_ID_VIDEO_REPAIR',
    'GCAL_ID_2ND_VIDEO_REPAIR','GCAL_ID_LEAK_SOURCE','GOOGLE_OAUTH_CLIENT_ID'
]

for k in keys:
    content = content.replace('%%' + k + '%%', os.environ.get(k, ''))

with open('index.html', 'w', encoding='utf-8') as f:
    f.write(content)

size = len(content.encode('utf-8')) // 1024
remaining = content.count('%%')
print('Output: {}KB, remaining markers: {}'.format(size, remaining))
