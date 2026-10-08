          fromRuntime: attempt.runtime,
          toRuntime: next.runtime,
          ...(sameRuntime ? { fromModel: model, toModel: next.model } : {}),
          originalError: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  throw new Error(
    attempts.length === 0 && blockedModels.size > 0
      ? '本轮可用的模型都已经因配额/限流失败而被跳过，请稍后重试或更换运行方式。'
      : '没有可用的 Agent Runtime。'
        + (lastQuotaError instanceof Error ? ' 原始错误：' + lastQuotaError.message : ''),
  );
}