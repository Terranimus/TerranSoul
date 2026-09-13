import asyncio, json
from harbor.db.client import RegistryDB
from harbor.models.package.reference import PackageReference

async def main():
    db = RegistryDB()
    ref = PackageReference.parse('terminal-bench/terminal-bench')
    package, version = await db.resolve_dataset_version(ref.org, ref.short_name, ref.ref)
    print('PACKAGE=', json.dumps(package, indent=2, default=str))
    print('VERSION=', json.dumps(version, indent=2, default=str))
    rows = await db.get_dataset_version_tasks(version['id'])
    print('COUNT=', len(rows))
    missing = [r for r in rows if not ((r.get('task_version') or {}).get('package'))]
    print('MISSING_PACKAGE=', len(missing))
    print(json.dumps(missing[:3], indent=2, default=str))

asyncio.run(main())
