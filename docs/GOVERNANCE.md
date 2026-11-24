# Governance

opencode-cache-manager is maintained by [Noppu Labs](https://noppu.com). It has one maintainer, who makes the final call on what is merged and released.

## Roles

| Role        | Who                                       | Responsibilities                                                                                                                                                       |
| ----------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Maintainer  | [@cris005](https://github.com/cris005)    | Reviews and merges pull requests, triages issues, cuts releases by merging a version bump, answers vulnerability reports, manages repository and organization settings |
| Contributor | Anyone who opens an issue or pull request | Follows [CONTRIBUTING.md](CONTRIBUTING.md); has no write access                                                                                                        |

## Access to sensitive resources

| Resource                                                                           | Who has access                                                                                                    |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| The GitHub repository (admin, including rulesets and Actions settings)             | [@cris005](https://github.com/cris005), the only owner of the `noppu-labs` organization and the only collaborator |
| Vulnerability reports and security advisories                                      | [@cris005](https://github.com/cris005)                                                                            |
| The npm packages `@noppu-labs/opencode-cache-manager` and `opencode-cache-manager` | The `noppu` npm account                                                                                           |
| Publishing a release                                                               | Nobody by hand: `release.yml` publishes through npm trusted publishing, and no npm token is stored                |

The organization requires two-factor authentication. `.github/CODEOWNERS` routes every pull request to the maintainer.
