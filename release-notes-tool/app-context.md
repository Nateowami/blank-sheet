# Application Context

## Overview

This application is a project management and collaboration platform. It supports multiple user roles organized into two tiers:

## Role Tiers

### System-Level Roles (administrative)
- **Serval Admin**: Platform-wide administrator with full access across all organizations and projects
- **System Admin**: Organization-level administrator responsible for configuring org-wide settings, managing users, and overseeing integrations

### Project-Level Roles (end users)
- **Project Admin**: Can manage project settings, members, and permissions within a single project
- **Editor**: Can create, edit, and submit content within a project
- **Viewer**: Read-only access to project content
- **Reviewer**: Can leave feedback and approve/reject submissions

## Domain Terminology

- **Project**: The primary unit of collaboration; contains tasks, documents, and members
- **Workspace**: A collection of related projects under a single organization
- **Submission**: Content created by Editors that goes through a review/approval workflow
- **Audit Log**: System-level record of all significant actions, visible to System Admins and Serval Admins
- **Feature Flag**: Configuration toggle used by System Admins to enable/disable features per environment or organization

## Classification Guide

- Changes to CI/CD pipelines, build scripts, test infrastructure, or developer tooling are **tooling**
- Changes to Serval Admin or System Admin dashboards, audit logs, system-level configuration, or org-level management are **internal**
- Changes affecting Project Admins, Editors, Viewers, Reviewers, or any end-user-visible UI/workflow are **user-facing**
