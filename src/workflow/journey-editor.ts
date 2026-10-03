  const version = await withWorkspaceContextLock(name, async () => {
    await ensureWorkspace(name);
    const active = await loadActiveJourney(name, workflowId);
    const nextVersion = active.source === 'custom' ? active.version + 1 : 1;
    const oldExecution = await loadJourneyExecution(
      name,
      active.definition,
      active.version,
    );
    const newNodeIds = new Set(definition.nodes.map((node) => node.id));
    const preservedCompleted = oldExecution.completedNodeIds.filter((id) => newNodeIds.has(id));
    const preservedCurrent = newNodeIds.has(oldExecution.currentNodeId)
      ? oldExecution.currentNodeId
      : definition.start;
    const preservedNode = definition.nodes.find((node) => node.id === preservedCurrent);
    const migratedExecutionBase: JourneyExecution = {
      workflowId: definition.id,
      workflowVersion: nextVersion,
      runId: definition.id + '-v' + String(nextVersion),
      currentNodeId: preservedCurrent,
      completedNodeIds: preservedCompleted,
      status: preservedNode?.type === 'end'
        ? 'completed'
        : preservedNode?.type === 'stop'
          ? 'stopped'
          : preservedNode?.actor === 'human'
            ? 'waiting'
            : 'active',
    };
    const migratedExecution: JourneyExecution = preservedNode?.actor === 'human'
      ? {
          ...migratedExecutionBase,
          pendingInteraction: {
            id: 'pending-' + definition.id + '-' + String(nextVersion),
            nodeId: preservedNode.id,
            reason: '等待人工完成“' + preservedNode.title + '”。',
            requestedAt: new Date().toISOString(),
          },
        }
      : migratedExecutionBase;

    await fs.mkdir(journeyDir(name), { recursive: true });
    await fs.writeFile(
      journeyFile(name, ACTIVE_FILE),
      serializeJourneyMarkdown(definition),