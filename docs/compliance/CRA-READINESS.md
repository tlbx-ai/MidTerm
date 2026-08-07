# Cyber Resilience Act readiness

Status: working technical assessment, 5 August 2026.

This document records the current engineering position. It is not legal advice,
an EU declaration of conformity, a certification, or permission to use the CE
marking. Regulation (EU) 2024/2847 applies in full from 11 December 2027; its
reporting obligations apply from 11 September 2026.

## Product and manufacturer scope

tlbx is downloadable, self-hosted software distributed as native installers and
release archives under the tlbx name. The public project is AGPL-3.0 and offers
commercial licensing. The non-commercial free-and-open-source exclusion must
therefore not be assumed for manufacturer planning.

The legal manufacturer for a future EU declaration of conformity is not yet
fixed. A GitHub organisation is not, by itself, a legal manufacturer. The
declaration must identify the responsible natural or legal person and address.

## Preliminary product classification

Working classification: default product with digital elements, not an important
Class I or II or critical product.

Rationale: tlbx's core functionality is a self-hosted terminal browser
multiplexer and control surface for persistent local terminal and agent
sessions. Authentication, the Dev Browser, network access, certificate helpers,
and update verification support that core function. Their presence does not by
itself make the product's core function identity lifecycle management,
privileged-access management, web browsing, VPN, network-element management,
SIEM, or another category listed in Annex III or IV.

This classification must receive an external legal/conformity review before a
declaration is signed. If tlbx is classified as an important Class I product,
Module A self-assessment may depend on fully applying suitable harmonised
standards; otherwise third-party conformity assessment may be required.

## Existing engineering evidence

| Area | Current evidence |
| --- | --- |
| Release provenance | GitHub build-provenance and SBOM attestations per native archive |
| Software composition | Platform-specific SPDX 2.3 SBOM per native archive |
| Update authenticity | ECDSA P-384 signed manifest-v2 with platform, channel, version, update type, and file hashes |
| Dependency control | Locked npm, NuGet, and Gradle graphs; signature/checksum validation; vulnerability audit release gate |
| Workflow integrity | GitHub Actions referenced by immutable commit SHA; CodeQL, Dependabot, secret scanning, and push protection |
| Runtime verification | Frontend, .NET, integration, runtime-build, Native-AOT startup, and API smoke gates |
| Third-party notices | Packaged `THIRD-PARTY-NOTICES.txt`, `THIRD-PARTY-LICENSES.txt`, and licence texts |
| Vulnerability intake | GitHub private vulnerability reporting and `SECURITY.md` |

Evidence is indexed by the release commit, annotated tag, GitHub Actions run,
release assets, and attestations. Detailed threat information and embargoed
vulnerability material must remain private.

## Essential-requirement work still required

Before a conformity assessment can close, the technical file must contain:

- fixed product identity, intended purpose, supported environments, and trust boundaries;
- a product cybersecurity risk assessment maintained across design, development, delivery, and support;
- an Annex I control matrix linking each applicable requirement to implementation, tests, and residual risk;
- evidence that the release is not placed on the market with known exploitable vulnerabilities;
- secure-default, authentication, confidentiality, integrity, availability, data-minimisation, and attack-surface assessments;
- vulnerability-handling, disclosure, remediation, update, rollback, and user-notification procedures;
- a justified support period and end-of-support communication;
- secure installation, operation, update, decommissioning, and data-removal instructions;
- test reports and the standards or technical specifications used;
- a signed EU declaration of conformity for the assessed product version.

## Reporting runbook for 11 September 2026

1. Preserve the report, affected versions, evidence, timestamps, reporter contact, and confidentiality status.
2. Determine whether the event is an actively exploited vulnerability in tlbx or a severe incident affecting tlbx security. A published CVE in a dependency is not automatically reportable without that product-specific condition.
3. Escalate immediately to the designated manufacturer decision-maker and technical owner. Do not wait for a complete root-cause analysis before starting the statutory clock assessment.
4. If reportable, submit the early warning through the ENISA Single Reporting Platform within 24 hours of awareness.
5. Submit the fuller notification within 72 hours, including available impact, exploitation, affected versions, and mitigation information.
6. For an actively exploited vulnerability, submit the final report no later than 14 days after a corrective or mitigating measure is available. For a severe incident, submit the final report within one month after the incident notification.
7. Inform affected users without undue delay when action is needed, using a security advisory, release notes, mitigation guidance, and an update as appropriate.
8. Retain the submissions, decisions, evidence, user communications, and final corrective-action record in the private technical file.

The manufacturer decision-maker, ENISA account ownership, out-of-hours contact,
and private evidence location remain operational decisions that must be fixed
before 11 September 2026.

## CE release gate

The CE marking remains blocked until all of the following are true:

- the CRA provisions requiring it apply to the product being placed on the market;
- the legal manufacturer and product identity are fixed;
- the product classification and applicable conformity procedure are confirmed;
- the technical file and conformity assessment are complete;
- all identified non-conformities are closed or the release is stopped;
- the responsible manufacturer has signed and dated the EU declaration of conformity.

Only then may the official CE marking be published on the declaration or the
easily accessible website accompanying the software. No current tlbx release or
website may claim CRA conformity, certification, or CE status.

## Backlog decisions

- Confirm the legal manufacturer and signatory.
- Obtain an external review of the preliminary default-product classification.
- Choose and publish the CRA support-period commitment.
- Complete the product risk assessment and Annex I evidence matrix.
- Assign the ENISA reporting roles and private evidence repository.
- Track harmonised standards and determine which will be applied.
- Prepare, but do not sign, the Annex V EU declaration template.
