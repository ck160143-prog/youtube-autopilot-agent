"use strict";

// Project store. One JSON file per project plus an asset directory, written
// atomically so a crash mid-write cannot corrupt a resumable project.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STATUSES = ["draft", "story", "generating", "assets", "rendering", "completed", "failed", "cancelled", "interrupted"];
const INTERRUPTED = ["story", "generating", "assets", "rendering"];

function makeProjectId() {
  return "p" + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
}

function createProject(input = {}) {
  const now = new Date().toISOString();
  return {
    id: input.id || makeProjectId(),
    ownerId: input.ownerId ? String(input.ownerId).slice(0, 40) : null,
    createdAt: now,
    updatedAt: now,
    topic: String(input.topic || "").trim().slice(0, 300),
    language: input.language === "English" ? "English" : "हिंदी",
    style: ["3d-cartoon", "cinematic", "realistic"].includes(input.style) ? input.style : "3d-cartoon",
    aspect: ["16:9", "9:16", "1:1"].includes(input.aspect) ? input.aspect : "16:9",
    quality: input.quality === "1080p" ? "1080p" : "720p",
    durationMinutes: Math.min(30, Math.max(1, Number(input.durationMinutes) || 1)),
    sceneCount: Math.max(3, Math.min(150, Number(input.sceneCount) || 10)),
    status: "draft",
    progress: { percent: 0, stage: "draft", message: "प्रोजेक्ट बना", updatedAt: now },
    error: null,
    warnings: [],
    story: null,
    timeline: null,
    assets: { scenes: {} },
    render: null,
  };
}

class ProjectStore {
  constructor(options = {}) {
    this.root = options.root || path.join(process.cwd(), "data", "projects");
  }

  ensure() {
    fs.mkdirSync(this.root, { recursive: true });
    return this;
  }

  fileFor(id) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(id))) {
      throw Object.assign(new Error("अमान्य project id।"), { statusCode: 400 });
    }
    return path.join(this.root, id + ".json");
  }

  dirFor(id) {
    // Same rule as fileFor: a project id is never a path. fileFor validated but
    // dirFor did not, so any future caller could have joined "../.." into it.
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(id))) {
      throw Object.assign(new Error("अमान्य project id।"), { statusCode: 400 });
    }
    return path.join(this.root, id);
  }

  list() {
    this.ensure();
    return fs.readdirSync(this.root)
      .filter(name => name.endsWith(".json"))
      .map(name => {
        try {
          const project = JSON.parse(fs.readFileSync(path.join(this.root, name), "utf8"));
          return {
            id: project.id, ownerId: project.ownerId || null, topic: project.topic, status: project.status,
            progress: project.progress, createdAt: project.createdAt,
            updatedAt: project.updatedAt, sceneCount: project.sceneCount,
            durationMinutes: project.durationMinutes, render: project.render,
          };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  // Ownerless projects are legacy records and stay visible until adopted.
  listFor(ownerId) {
    return this.list().filter(project => !project.ownerId || (ownerId && project.ownerId === ownerId));
  }

  get(id) {
    const file = this.fileFor(id);
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (_) {
      return null;
    }
  }

  save(project) {
    this.ensure();
    project.updatedAt = new Date().toISOString();
    if (project.progress) project.progress.updatedAt = project.updatedAt;
    const file = this.fileFor(project.id);
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(project, null, 2));
    fs.renameSync(tmp, file);
    return project;
  }

  // Called at boot: anything that was mid-flight when the process died is
  // marked interrupted. Assets on disk survive, so the same project resumes
  // from its last completed clip.
  recoverInterrupted() {
    this.ensure();
    let count = 0;
    for (const name of fs.readdirSync(this.root)) {
      if (!name.endsWith(".json")) continue;
      try {
        const project = JSON.parse(fs.readFileSync(path.join(this.root, name), "utf8"));
        if (!INTERRUPTED.includes(project.status)) continue;
        project.status = "interrupted";
        project.progress = {
          ...(project.progress || {}),
          stage: "interrupted",
          message: "Server restart — यहीं से resume करें",
          updatedAt: new Date().toISOString(),
        };
        this.save(project);
        count += 1;
      } catch (_) { /* unreadable project file: leave it alone */ }
    }
    return count;
  }

  adoptOwner(ownerId) {
    let count = 0;
    for (const project of this.list()) {
      if (project.ownerId) continue;
      const full = this.get(project.id);
      if (!full) continue;
      full.ownerId = ownerId;
      this.save(full);
      count += 1;
    }
    return count;
  }

  remove(id) {
    const file = this.fileFor(id);
    let removed = false;
    try {
      fs.rmSync(file, { force: true });
      removed = true;
    } catch (_) {
      removed = false;
    }
    try {
      fs.rmSync(this.dirFor(id), { recursive: true, force: true });
    } catch (_) {
      /* assets may not exist */
    }
    return removed;
  }

  setStatus(project, status, message) {
    if (STATUSES.includes(status)) project.status = status;
    project.progress = {
      ...(project.progress || {}),
      stage: status,
      message: message || (project.progress && project.progress.message) || "",
      updatedAt: new Date().toISOString(),
    };
    return this.save(project);
  }
}

module.exports = { ProjectStore, createProject, STATUSES, makeProjectId };
