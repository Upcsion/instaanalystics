# instaanalystics

Skills and scripts for pulling reporting data from Instantly.ai.

## Skills

- [`skills/instantly-campaign-pull`](skills/instantly-campaign-pull/SKILL.md) — pulls per-campaign contacted / not-contacted lead counts and sendable capacity for the daily send tracker.

```
export IK=<instantly api key>
python3 skills/instantly-campaign-pull/pull.py --csv output.csv
```

Requires outbound network access to `https://api.instantly.ai`.
