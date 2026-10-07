import { useEffect, useState } from 'react';
import { getJson } from '../app/api.js';
import { RemoteMediaResolveResponseSchema } from '../../../src/api/contracts.js';
import { Avatar } from 'antd';
import { RobotOutlined } from '@ant-design/icons';
import type { InvestigationControl } from '../app/types';

function isRemoteSource(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

function getLocalAvatarId(source: string): string | undefined {
  const filename = source.split(/[\\/]/).pop()?.split(/[?#]/, 1)[0];
  return filename?.replace(/\.[^.]+$/, '') || undefined;
}

const remoteResolutionCache = new Map<string, Promise<{
  kind: 'image' | 'video' | 'remote';
  remoteUrl?: string;
  cacheUrl?: string;
}>>();

async function resolveRemoteSource(source: string, kind: 'image' | 'video' | 'remote') {
  const key = kind + ':' + source;
  const existing = remoteResolutionCache.get(key);
  if (existing) return existing;
  const request = getJson('/api/global/media/resolve', RemoteMediaResolveResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: source, kind }),
  }).then((result) => ({
    kind: result.kind,
    ...(result.remoteUrl ? { remoteUrl: result.remoteUrl } : {}),
    ...(result.cacheUrl ? { cacheUrl: result.cacheUrl } : {}),
  }));
  remoteResolutionCache.set(key, request);
  return request;
}

function isVideoSource(source: string, control: InvestigationControl): boolean {
  return control.agent.avatarSources?.some((item) => item.src === source && item.kind === 'video') === true
    || /\.(mp4|webm|mov|m4v)(?:[?#].*)?$/i.test(source);
}

/** 渲染助手头像，统一处理本地图片、GIF、视频以及 HTTPS 远程资源。 */
export function AssistantAvatar(props: {
  sessionName: string;
  control: InvestigationControl;
  avatarPath?: string;
}) {
  const width = Math.max(40, props.control.agent.avatarWidth || 180);
  const height = Math.max(40, props.control.agent.avatarHeight || 240);
  const source = props.avatarPath
    ?? props.control.agent.avatarSources?.[0]?.src
    ?? props.control.agent.avatarPaths?.[0];

  const [loadFailed, setLoadFailed] = useState(false);
  const [resolvedMedia, setResolvedMedia] = useState<{
    kind: 'image' | 'video' | 'remote';
    remoteUrl?: string;
    cacheUrl?: string;
  }>();
  const [usingCache, setUsingCache] = useState(false);

  const isRemote = source ? isRemoteSource(source) : false;
  const sourceKind = source && isVideoSource(source, props.control) ? 'video' : 'remote';
  const isVideo = source ? (resolvedMedia?.kind === 'video' || (!resolvedMedia && sourceKind === 'video')) : false;
  const localId = source && !isRemote ? getLocalAvatarId(source) : undefined;
  const localUrl = localId
    ? `/api/sessions/${encodeURIComponent(props.sessionName)}/assistant/avatar/${encodeURIComponent(localId)}?v=${props.control.version}`
    : undefined;
  const remoteUrl = resolvedMedia?.remoteUrl ?? (isRemote && !usingCache ? source : undefined);
  const cacheUrl = resolvedMedia?.cacheUrl;
  const url = source
    ? isRemote
      ? (usingCache ? cacheUrl : remoteUrl)
      : localUrl
    : undefined;

  useEffect(() => {
    setLoadFailed(false);
    setUsingCache(false);
    setResolvedMedia(undefined);
    if (!source || !isRemote) return;

    let cancelled = false;
    void resolveRemoteSource(source, sourceKind)
      .then((result) => {
        if (cancelled) return;
        setLoadFailed(false);
        setUsingCache(false);
        setResolvedMedia(result);
      })
      .catch(() => {
        // Direct media URLs can still be used without the resolver. Non-direct pages
        // simply show the fallback state when neither resolution nor cache is available.
        if (!cancelled) setResolvedMedia({ kind: sourceKind });
      });
    return () => { cancelled = true; };
  }, [source, isRemote, sourceKind, props.control.version]);

  if (!source) {
    return <Avatar shape="square" icon={<RobotOutlined />} style={{ width, height, flex: '0 0 auto' }} />;
  }

  if (!url && isRemote) {
    return <Avatar shape="square" icon={<RobotOutlined />} style={{ width, height, flex: '0 0 auto', borderRadius: 8 }} />;
  }

  if (loadFailed) {
    return (
      <Avatar
        shape="square"
        icon={<RobotOutlined />}
        style={{ width, height, flex: '0 0 auto', borderRadius: 8 }}
      />
    );
  }

  if (isVideo) {
    return (
      <video
        src={url}
        autoPlay
        loop
        muted
        playsInline
        title={props.control.agent.displayName || '助手头像'}
        onError={() => {
          if (!usingCache && cacheUrl) {
            setUsingCache(true);
            setLoadFailed(false);
          } else {
            setLoadFailed(true);
          }
        }}
        style={{ width, height, objectFit: 'cover', flex: '0 0 auto', borderRadius: 8, display: 'block' }}
      />
    );
  }

  return (
    <img
      src={url}
      alt={props.control.agent.displayName || '助手头像'}
      onError={() => {
        if (!usingCache && cacheUrl) {
          setUsingCache(true);
          setLoadFailed(false);
        } else {
          setLoadFailed(true);
        }
      }}
      style={{ width, height, objectFit: 'cover', flex: '0 0 auto', borderRadius: 8, display: 'block' }}
    />
  );
}
