---
id: {{id}}
title: {{title}}
repo: {{repo}}
status: todo
done: pr-ready        # local | local-reviewed | draft-pr | pr-ready | merged | or plain words
model:                # haiku | sonnet | opus  (empty: the planner proposes)
effort:               # low | medium | high | xhigh  (empty: the planner proposes)
approved: false       # true: starts without waiting for your approval
created: {{created}}
---

## Context

Why this matters, what you know, links, files to look at.

## Constraints

- What the agent must not do or change.

## Done looks like

- What you will check to call it done.

## Where we are

_The agent keeps this up to date._

## Questions

## Answers

_Write your answers here, then run `answer {{id}}`._
