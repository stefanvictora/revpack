# revpack

revpack prepares local review bundles for coding agents and lets people decide which agent outputs are published back to the review target.

## Language

### Review Workflow

**Review Target**:
A pull request, merge request, or local branch range that revpack prepares for review.
_Avoid_: Change request, review subject

**Prepare**:
The action of creating or refreshing a review bundle for a review target without producing or publishing review material.
_Avoid_: Generate, build, fetch

**Checkout**:
The action of making a review target available in the local repository and preparing its review bundle.
_Avoid_: Clone, switch, fetch

**Review Bundle**:
A disposable local package of review context created for a review target so an agent can use the relevant diff, review threads, and instructions for a revpack review or another developer-directed task.
_Avoid_: Context folder, workspace, review package

**Revpack Review**:
An explicitly requested agent task that evaluates a review target under the review contract and produces agent output for later inspection and publishing.
_Avoid_: Bundle context use, any task that merely reads a review bundle

**Bundle Context Use**:
The use of a review bundle as supporting context for a developer-directed task without activating the review contract. Merely reading a review bundle does not make the task a revpack review.
_Avoid_: Review mode, informal review

**Publish**:
The intentional action of applying agent output back to the review target through its provider.
_Avoid_: Post, submit, send, upload

**Guided Publish**:
An interactive publish flow that summarizes publishable review material before asking which items to publish.
_Avoid_: Publish all, auto-publish

**Checkpoint**:
A published marker of the review target state that future prepares use to decide what changed since the last intentional review.
_Avoid_: Baseline, snapshot, save point

**Incremental Review**:
A review pass focused on changes since the last checkpoint rather than the entire review target.
_Avoid_: Follow-up review, delta review

**Local Review**:
A review of committed local branch changes before a pull request or merge request exists.
_Avoid_: Offline review, branch review

### Review Material

**Agent Output**:
Draft review material written by an agent for later inspection and publishing.
_Avoid_: Bot comment, generated result

**Finding**:
A new agent-proposed line comment about code changed in the review target. A finding must have a valid positional anchor.
_Avoid_: Issue, defect, annotation

**Positional Anchor**:
The valid diff position where a finding can be published on a review target.
_Avoid_: Anchor, line number, file location

**Anchor Map**:
A review bundle artifact that maps diff text to valid positional anchors without serving as the diff used to understand the change.
_Avoid_: Line map, annotated diff

**Reply**:
An agent-proposed, publishable response to an existing review thread.
_Avoid_: Response, answer, follow-up comment

**Resolution Intent**:
An agent-proposed decision to resolve a review thread after its reply is published. It expresses whether the reply completes the discussion, independently of whether the provider reports the thread as resolvable before that reply.
_Avoid_: Resolve flag, resolvable state

**Review Thread**:
A provider-neutral, addressable review conversation containing one or more comments and attached to the review target, a file, or a line. It can receive replies; its placement and support for resolution are independent properties.
_Avoid_: Discussion, conversation, comment thread, review item

**Active Review Thread**:
A review thread containing authored feedback that remains part of the current review work because it has not been resolved. Provider system events alone do not create an active review thread.
_Avoid_: Active/general thread, unresolved thread as an umbrella term, general comment

**Resolved Review Thread**:
A review thread whose provider state says the discussion has been resolved, while still remaining valid context and a possible target for later replies.
_Avoid_: Closed thread, archived thread

**Provider System Event**:
Provider-generated activity metadata attached to a review thread rather than authored review feedback.
_Avoid_: System comment, bot comment

**Review Note**:
A standalone target-level comment proposed in agent output rather than attached to a specific line or existing review thread.
_Avoid_: General comment, review body

**Commit List**:
A review bundle artifact that lists the commits included in the review target and preserves their messages as intent context.
_Avoid_: Changelog, history dump

**Summary**:
A target description section maintained by revpack to summarize the reviewed changes.
_Avoid_: Description, overview

### Configuration and Agent Setup

**Provider**:
The system revpack reads review data from and publishes review material back to, including hosted code review services and local Git.
_Avoid_: Integration, host, backend

**Profile**:
A named set of provider settings used to connect revpack to a repository workflow. A profile references credentials but is not itself a credential.
_Avoid_: Account, configuration, credential set

**Credential Reference**:
A profile field that names where revpack can read a credential at runtime without storing the credential value.
_Avoid_: Credential, secret, token value

**Provider Authentication**:
The provider access setup represented by a profile and its credential references. Revpack stores the references, not provider credential values.
_Avoid_: Login, token storage, connection

**Review Guidance**:
Project-specific review priorities that agents should follow when reviewing a review bundle.
_Avoid_: Instructions, contract, prompt

**Review Contract**:
The mandatory review rules an agent must follow while producing agent output for a review bundle.
_Avoid_: Guidance, checklist, prompt

**Agent Instruction**:
A project-level artifact that tells a specific agent how to use a review bundle for a supported task.
_Avoid_: Harness, adapter, integration, prompt

**Per-run Instruction Burden**:
The amount of agent instruction content required for a particular review run, evaluated primarily by token usage and clarity.
_Avoid_: Template size, source line count, instruction file count
