# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

Category roles use GitHub's existing `bug` and `enhancement` labels, which already match the canonical names. `wontfix` already exists in this tracker.

The four missing state labels must be created once by a repo owner before the first `/triage` run. The Cloud Agent GitHub token cannot create them (`HTTP 403: Resource not accessible by integration`). Use the GitHub UI at https://github.com/fol2/ks2-spelling/labels, or run this locally with `gh` authenticated as an owner:

```bash
gh label create needs-triage --repo fol2/ks2-spelling --description "Maintainer needs to evaluate this issue" --color "FBCA04"
gh label create needs-info --repo fol2/ks2-spelling --description "Waiting on reporter for more information" --color "D876E3"
gh label create ready-for-agent --repo fol2/ks2-spelling --description "Fully specified, ready for an AFK agent" --color "0E8A16"
gh label create ready-for-human --repo fol2/ks2-spelling --description "Requires human implementation" --color "1D76DB"
```
