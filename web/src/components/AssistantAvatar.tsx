import { Avatar } from 'antd';
import { RobotOutlined } from '@ant-design/icons';
import type { InvestigationControl } from '../app/types';

function isRemoteSource(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

function getLocalAvatarId(source: string): string | undefined {
  return source.split('/').pop()?.replace(/\.[^.]+$/, '');
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
    ?? props.control.agent.avatarPath
    ?? props.control.agent.avatarPaths?.[0];

  if (!source) {
    return <Avatar shape="square" icon={<RobotOutlined />} style={{ width, height, flex: '0 0 auto' }} />;
  }

  const isRemote = /^https?:\\/\\//i.test(source);
  const localId = source.split('/').pop()?.replace(/\\.[^.]+$/, '');
  const url = isRemote
    ? source
    : `/api/sessions/${encodeURIComponent(props.sessionName)}/assistant/avatar/${localId}?v=${props.control.version}`;
  const isVideo = props.control.agent.avatarSources?.find((item) => item.src === source)?.kind === 'video'
    || /\\.(mp4|webm|mov|m4v)(?:[?#].*)?$/i.test(source);

  if (isVideo) {
    return (
      <video
        src={url}
        autoPlay
        loop
        muted
        playsInline
        title={props.control.agent.displayName || '助手头像'}
        style={{ width, height, objectFit: 'cover', flex: '0 0 auto', borderRadius: 8, display: 'block' }}
      />
    );
  }

  return (
    <img
      src={url}
      alt={props.control.agent.displayName || '助手头像'}
      style={{ width, height, objectFit: 'cover', flex: '0 0 auto', borderRadius: 8, display: 'block' }}
    />
  );
}
