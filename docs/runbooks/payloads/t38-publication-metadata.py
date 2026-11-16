#!/usr/bin/env python3
"""Read-only GitHub publication metadata. Fixed endpoints, no secrets/variables API."""
import json
import os
import shutil
import subprocess

TASK = 'T38'
REQUESTS = (
    ('app_pages', 'repos/bronservis51-bot/bron-franchise/pages'),
    ('landing_pages', 'repos/bronservis51-bot/bronservice-franchise/pages'),
    ('app_pages_environment', 'repos/bronservis51-bot/bron-franchise/environments/github-pages'),
    ('release_pr', 'repos/bronservis51-bot/bron-franchise/pulls/12'),
)


def select(name, value):
    if not isinstance(value, dict):
        raise ValueError('shape')
    if name.endswith('_pages'):
        source = value.get('source') or {}
        return {**{k: value.get(k) for k in ('build_type', 'status', 'cname', 'html_url')},
                'source': {k: source.get(k) for k in ('branch', 'path')}}
    if name == 'app_pages_environment':
        rules = value.get('protection_rules') or []
        return {'name': value.get('name'), 'deployment_branch_policy': value.get('deployment_branch_policy'),
                'protection_rules': [{'type': r.get('type'), 'wait_timer': r.get('wait_timer'),
                    'prevent_self_review': r.get('prevent_self_review'),
                    'reviewer_count': len(r.get('reviewers') or [])} for r in rules if isinstance(r, dict)]}
    if name == 'release_pr':
        return {'number': value.get('number'), 'state': value.get('state'), 'draft': value.get('draft'),
                'mergeable': value.get('mergeable'), 'mergeable_state': value.get('mergeable_state'),
                'head': {k: (value.get('head') or {}).get(k) for k in ('ref', 'sha')},
                'base': {k: (value.get('base') or {}).get(k) for k in ('ref', 'sha')}}
    raise ValueError('scope')


def main():
    gh = shutil.which('gh')
    result = {'task': TASK, 'mode': 'READ_ONLY_METADATA', 'sourceDataRead': False,
              'vpsAccess': False, 'ownerInputRequested': False, 'requests': {}}
    if not gh:
        result['status'] = 'GH_UNAVAILABLE'
    else:
        env = dict(os.environ, GH_PROMPT_DISABLED='1', GH_PAGER='cat')
        env.pop('GH_DEBUG', None)
        for name, endpoint in REQUESTS:
            try:
                child = subprocess.run([gh, 'api', '--hostname', 'github.com', '--method', 'GET', endpoint],
                    stdin=subprocess.DEVNULL, capture_output=True, timeout=15, check=False, env=env)
                if child.returncode:
                    result['requests'][name] = {'status': 'BLOCKED', 'code': 'GH_READ_FAILED',
                                                'exit': child.returncode}
                elif len(child.stdout) > 2097152:
                    result['requests'][name] = {'status': 'BLOCKED', 'code': 'GH_RESPONSE_BOUND'}
                else:
                    result['requests'][name] = {'status': 'PASS', 'metadata': select(name, json.loads(child.stdout))}
            except subprocess.TimeoutExpired:
                result['requests'][name] = {'status': 'BLOCKED', 'code': 'GH_READ_TIMEOUT'}
            except Exception:
                result['requests'][name] = {'status': 'BLOCKED', 'code': 'GH_READ_OR_SHAPE_FAILED'}
        result['status'] = 'COMPLETE' if all(v['status'] == 'PASS' for v in result['requests'].values()) else 'PARTIAL'
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == '__main__':
    main()
