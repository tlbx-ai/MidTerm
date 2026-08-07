# Support policy

This policy describes the current voluntary support model for tlbx releases.
It does not claim conformity with the EU Cyber Resilience Act and is not an EU
declaration of conformity.

## Release lines

| Release line | Status | Security handling |
| --- | --- | --- |
| Current stable release | Supported | Security fixes and mitigations are delivered through a current compatible stable release. |
| Current dev prerelease | Evaluation | Reports are accepted; fixes may require updating to a newer prerelease. |
| Historical releases | Unsupported unless an advisory states otherwise | Users are directed to a supported release. Separate backports are not promised. |

Security updates are provided without an additional fee. Supporting a release
does not mean that every historical patch receives a backport; a supported fix
may be delivered by updating to the current compatible version.

## End of support

tlbx does not silently designate an unsupported release as current. The release
page, installer channel, and built-in update service identify the available
current release. A dated product support period for releases placed on the EU
market under the Cyber Resilience Act will be published before that regime
fully applies on 11 December 2027.

## Getting help

- Security vulnerability: use [private vulnerability reporting](https://github.com/tlbx-ai/tlbx/security/advisories/new).
- Product defect or hardening idea: use the [public issue tracker](https://github.com/tlbx-ai/tlbx/issues).
- Release authenticity: follow [Release integrity](docs/RELEASE-INTEGRITY.md).

Commercial licensing does not reduce access to security updates for the public
AGPL release line.
