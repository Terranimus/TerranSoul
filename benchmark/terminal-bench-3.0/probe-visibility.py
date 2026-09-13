import asyncio, json
from harbor.auth.client import create_authenticated_client
from harbor.db.client import RegistryDB
from harbor.models.package.reference import PackageReference

async def main():
    db = RegistryDB(); ref = PackageReference.parse('terminal-bench/terminal-bench')
    _pkg, version = await db.resolve_dataset_version(ref.org, ref.short_name, ref.ref)
    client = await create_authenticated_client()
    r = await (client.table('dataset_version_task').select('task_version_id').eq('dataset_version_id', version['id']).execute())
    ids = [x['task_version_id'] for x in (r.data or [])]
    print('IDS=', ids[:5])
    for id in ids[:3]:
       raw = await client.table('task_version').select('*').eq('id',id).execute()
       print(id, 'count=', len(raw.data or []), json.dumps(raw.data, default=str)[:500])

asyncio.run(main())
