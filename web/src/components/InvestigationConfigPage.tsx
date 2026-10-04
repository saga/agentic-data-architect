import React, { useEffect, useState } from 'react';
import ImgCrop from 'antd-img-crop';
import { Alert, Avatar, Button, Card, Divider, Empty, Flex, Input, InputNumber, Radio, Select, Space, Tag, Typography, Upload } from 'antd';
import { ArrowLeftOutlined, DeleteOutlined, PlusOutlined, SaveOutlined, SettingOutlined, ToolOutlined, GithubOutlined, HistoryOutlined, PictureOutlined, UploadOutlined } from '@ant-design/icons';

const { Title, Text, Paragraph } = Typography;

export interface ConfigPageControl {
  version:number; updatedAt:string;
  research:{ githubRepositories:string[]; githubSearchMode:'only_selected'|'selected_and_broad'; keywords:string[]; importantDocuments:Array<{id:string;title:string;reference:string}> };
  agent:{ permissionMode:'permission'|'allow_all'; displayName:string; avatarPath?:string; avatarPaths?:string[]; avatarMimeType?:'image/png'|'image/jpeg'|'image/webp'; avatarWidth:number; avatarHeight:number; systemPrompt:{version:number;content:string}; mcpServers:Array<{name:string;version:number;enabled:boolean;type:'local'|'http';command?:string;args?:string[];url?:string;tools?:string[];headers?:Record<string,string>}> };
  history:Array<{version:number;updatedAt:string;reason:string}>;
}
export type ConfigWorkflow = ''|'legacy-modernization'|'financial-ai-native-architecture'|'data-architecture-assessment';

const workflowOptions:{value:ConfigWorkflow;label:string}[]=[
 {value:'',label:'自主调查'},
 {value:'legacy-modernization',label:'改造已有系统'},
 {value:'financial-ai-native-architecture',label:'金融 AI / 数据架构设计'},
 {value:'data-architecture-assessment',label:'数据架构评估'},
];

function clone<T>(value:T):T{return JSON.parse(JSON.stringify(value)) as T;}
function formatTime(value:string){const d=new Date(value);return Number.isNaN(d.getTime())?value:d.toLocaleString();}

export function InvestigationConfigPage(props:{
  sessionName:string;
  control:ConfigPageControl;
  workflow:ConfigWorkflow;
  onBack:()=>void;
  onWorkflowChange:(workflow:ConfigWorkflow)=>Promise<void>;
  onSaved:(control:ConfigPageControl)=>Promise<void>|void;
}){
  const [draft,setDraft]=useState<ConfigPageControl>(()=>clone(props.control));
  const [tab,setTab]=useState<'workflow'|'research'|'skills'|'mcp'|'history'>('research');
  const [saving,setSaving]=useState(false);
  const [workflowTarget,setWorkflowTarget]=useState<ConfigWorkflow>();
  const [confirmText,setConfirmText]=useState('');
  const [avatarUploading,setAvatarUploading]=useState(false);
  const [avatarError,setAvatarError]=useState<string>();

  useEffect(()=>setDraft(clone(props.control)),[props.control]);
  const update=(mutator:(next:ConfigPageControl)=>void)=>setDraft(prev=>{const next=clone(prev);mutator(next);return next;});

  const save=async()=>{
    setSaving(true);
    try{
      const response=await fetch(`/api/sessions/${encodeURIComponent(props.sessionName)}/config`,{
        method:'PUT',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({research:draft.research,agent:draft.agent}),
      });
      if(!response.ok) throw new Error((await response.text())||response.statusText);
      const data=await response.json() as {control:ConfigPageControl};
      setDraft(data.control);
      await props.onSaved(data.control);
    }finally{setSaving(false);}
  };

  /** 将裁剪器输出再压缩成当前配置的精确像素尺寸，保证头像文件不会因为原图太大而失控。 */
  const resizeAvatarToTarget = async (file: File): Promise<File> => {
    const sourceUrl = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('无法读取裁剪后的头像。'));
        image.src = sourceUrl;
      });

      const canvas = document.createElement('canvas');
      canvas.width = draft.agent.avatarWidth;
      canvas.height = draft.agent.avatarHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('当前浏览器不支持头像图片处理。');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => {
          if (value) resolve(value);
          else reject(new Error('无法生成头像文件。'));
        }, 'image/png');
      });
      return new File([blob], 'avatar.png', { type: 'image/png' });
    } finally {
      URL.revokeObjectURL(sourceUrl);
    }
  };

  /** 接收 antd-img-crop 已经完成裁剪的文件，再上传到当前 Investigation。 */
  const handleAvatarBeforeUpload = async (file: File) => {
    setAvatarUploading(true);
    setAvatarError(undefined);
    try {
      const resized = await resizeAvatarToTarget(file);
      const body = new FormData();
      body.append('file', resized, 'avatar.png');
      body.append('width', String(draft.agent.avatarWidth));
      body.append('height', String(draft.agent.avatarHeight));

      const response = await fetch(
        `/api/sessions/${encodeURIComponent(props.sessionName)}/assistant/avatar`,
        { method: 'POST', body },
      );
      if (!response.ok) {
        const error = await response.text();
        throw new Error(error || response.statusText);
      }

      const data = await response.json() as { control: ConfigPageControl };
      setDraft(clone(data.control));
      await props.onSaved(data.control);
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : '头像上传失败，请重试。');
    } finally {
      setAvatarUploading(false);
    }

    return false;
  };

  const mutateMcp=(index:number, patch:Partial<ConfigPageControl['agent']['mcpServers'][number]>)=>update(next=>{next.agent.mcpServers[index]={...next.agent.mcpServers[index],...patch};});
  const removeMcp=(index:number)=>update(next=>{next.agent.mcpServers.splice(index,1);});
  const addMcp=()=>update(next=>{next.agent.mcpServers.push({name:`mcp-${next.agent.mcpServers.length+1}`,version:1,enabled:true,type:'http',url:'',tools:[]});});

  return <div className='config-page-shell'>
    <header className='subpage-header'>
      <Flex align='center' gap={10}>
        <Button type='text' icon={<ArrowLeftOutlined/>} onClick={props.onBack}>返回调查</Button>
        <Divider orientation='vertical'/>
        <SettingOutlined/> <Title level={4} style={{margin:0}}>调查配置</Title>
        <Tag>v{props.control.version}</Tag>
      </Flex>
      <Space>
        <Button icon={<SaveOutlined/>} type='primary' loading={saving} onClick={()=>void save()}>保存配置</Button>
      </Space>
    </header>
    <div className='config-page-body'>
      <aside className='config-page-nav'>
        {([['research','研究范围',<GithubOutlined/>],['skills','Agent 指导',<ToolOutlined/>],['mcp','MCP',<ToolOutlined/>],['workflow','工作方式',<SettingOutlined/>],['history','版本历史',<HistoryOutlined/>]] as const).map(([key,label,icon])=><button key={key} className={tab===key?'active':''} onClick={()=>setTab(key as typeof tab)}>{icon}<span>{label}</span></button>)}
      </aside>
      <main className='config-page-content'>
        {tab==='research'&&<div className='settings-page'>
          <Title level={4}>研究范围</Title><Paragraph type='secondary'>决定 Agent 优先查什么资料。这里是调查输入，不改变工作方式。</Paragraph>
          <Card title='GitHub 仓库' className='settings-card'><Select mode='tags' value={draft.research.githubRepositories} style={{width:'100%'}} tokenSeparators={[',']} placeholder='https://github.com/org/repo' onChange={value=>update(next=>{next.research.githubRepositories=value;})}/>
            <div className='field-label'>搜索范围</div><Radio.Group value={draft.research.githubSearchMode} optionType='button' buttonStyle='solid' options={[{value:'only_selected',label:'仅搜索已选仓库'},{value:'selected_and_broad',label:'先搜索已选仓库，再扩大范围'}]} onChange={e=>update(next=>{next.research.githubSearchMode=e.target.value;})}/>
          </Card>
          <Card title='研究关键词' className='settings-card'><Paragraph type='secondary'>希望 Agent 主动关注的重要业务或技术术语。</Paragraph><Select mode='tags' style={{width:'100%'}} tokenSeparators={[',']} value={draft.research.keywords} onChange={value=>update(next=>{next.research.keywords=value;})} placeholder='例如：持仓、证券主数据、代理投票...'/></Card>
          <Card title='重要文档' className='settings-card'><Paragraph type='secondary'>优先参考的上传文件、URL 或路径。</Paragraph><Select mode='tags' style={{width:'100%'}} tokenSeparators={[',']} value={draft.research.importantDocuments.map(x=>x.reference)} onChange={refs=>update(next=>{next.research.importantDocuments=refs.map(ref=>({id:ref,title:ref.split('/').pop()||ref,reference:ref}));})} placeholder='文件、URL 或路径'/></Card>
        </div>}
        {tab==='skills'&&<div className='settings-page'>
          <Title level={4}>Agent 指导</Title>
          <Card title='对话显示' className='settings-card'>
             <Paragraph type='secondary'>这个名字只用于对话里的说话人标识和复制出来的聊天记录，不会改变 Agent 的实际角色或权限。</Paragraph>
             <div className='field-label'>助手名称</div>
             <Input
               value={draft.agent.displayName}
               maxLength={40}
               showCount
               placeholder='例如：秘书'
               onChange={e=>update(next=>{next.agent.displayName=e.target.value;})}
             />
           </Card>
           <Card title='头像' className='settings-card'>
             <Flex align='flex-start' gap={18} wrap>
               <Avatar
                 shape='square'
                 src={
                   draft.agent.avatarPath
                     ? `/api/sessions/${encodeURIComponent(props.sessionName)}/assistant/avatar?v=${props.control.version}`
                     : undefined
                 }
                 icon={<PictureOutlined />}
                 style={{
                   width: 72,
                   height: Math.round(72 * draft.agent.avatarHeight / draft.agent.avatarWidth),
                   maxHeight: 180,
                   flex: '0 0 auto',
                   objectFit: 'cover',
                 }}
               />
               <div style={{minWidth:260,flex:'1 1 320px'}}>
                 <Paragraph type='secondary'>可以上传任意数量的头像。每条秘书回复会随机选择一个头像；上传新的头像不会覆盖已有头像。</Paragraph>
                 <Flex gap={8} wrap>
                   <ImgCrop
                     aspect={draft.agent.avatarWidth / draft.agent.avatarHeight}
                     zoomSlider
                     rotationSlider
                     showReset
                     quality={1}
                     modalTitle='裁剪助手头像'
                     modalOk='使用此头像'
                     modalCancel='取消'
                     showGrid
                   >
                     <Upload
                       accept='image/png,image/jpeg,image/webp'
                       showUploadList={false}
                       beforeUpload={(file) => {
                         void handleAvatarBeforeUpload(file);
                         return false;
                       }}
                     >
                       <Button icon={<UploadOutlined />} loading={avatarUploading}>上传头像</Button>
                     </Upload>
                   </ImgCrop>
                 </Flex>
                 {(draft.agent.avatarPaths?.length ?? (draft.agent.avatarPath ? 1 : 0)) > 0 ? (
                   <Flex wrap gap={8} style={{marginTop:12}}>
                     {(draft.agent.avatarPaths ?? (draft.agent.avatarPath ? [draft.agent.avatarPath] : [])).map((avatarPath) => {
                       const avatarId = avatarPath.split('/').pop()?.replace(/\.png$/i, '');
                       return (
                         <Avatar
                           key={avatarPath}
                           shape='square'
                           src={avatarId
                             ? `/api/sessions/${encodeURIComponent(props.sessionName)}/assistant/avatar/${avatarId}?v=${props.control.version}`
                             : undefined}
                           icon={<PictureOutlined />}
                           style={{width:48,height:Math.round(48 * draft.agent.avatarHeight / draft.agent.avatarWidth),objectFit:'cover'}}
                         />
                       );
                     })}
                   </Flex>
                 ) : null}
                 <Text type='secondary' style={{display:'block',marginTop:8}}>
                   已上传 {(draft.agent.avatarPaths?.length ?? (draft.agent.avatarPath ? 1 : 0))} 个头像
                 </Text>
               </div>
             </Flex>
             {avatarError ? <Alert type='error' showIcon title={avatarError} style={{marginTop:14}} /> : null}
             <Divider style={{margin:'18px 0 14px'}} />
             <Flex gap={12} wrap>
               <div>
                 <div className='field-label'>输出宽度（像素）</div>
                 <InputNumber min={40} max={800} value={draft.agent.avatarWidth} onChange={value=>update(next=>{next.agent.avatarWidth=Number(value ?? 180);})} />
               </div>
               <div>
                 <div className='field-label'>输出高度（像素）</div>
                 <InputNumber min={40} max={1200} value={draft.agent.avatarHeight} onChange={value=>update(next=>{next.agent.avatarHeight=Number(value ?? 240);})} />
               </div>
               <div style={{alignSelf:'end',paddingBottom:4}}>
                 <Text type='secondary'>默认 180 × 240。修改尺寸后，下一次裁剪按新的比例处理。</Text>
               </div>
             </Flex>
           </Card>
           <Card title='Agent 权限' className='settings-card'>
            <Paragraph type='secondary'>决定 Agent 执行命令、读写文件或调用需要确认的工具时，是否先向你确认。</Paragraph>
            <div className='permission-mode-control'>
              <Radio.Group
                value={draft.agent.permissionMode}
                optionType='button'
                buttonStyle='solid'
              options={[
                { value:'permission', label:'按需确认' },
                { value:'allow_all', label:'Allow All Access from Agent' },
              ]}
                onChange={e=>update(next=>{next.agent.permissionMode=e.target.value;})}
              />
              <Tag color='blue'>当前：{draft.agent.permissionMode==='allow_all'?'Allow All Access from Agent':'按需确认'}</Tag>
            </div>
            {draft.agent.permissionMode==='allow_all' ? (
              <Alert
                style={{marginTop:12}}
                type='warning'
                showIcon
                title='Agent 将自动批准权限请求'
                description='本次调查后续执行不再逐项弹出确认。修改配置并保存后，新一轮 Agent 执行才会使用这个设置。'
              />
            ) : (
              <Text type='secondary' style={{display:'block',marginTop:10}}>
                Agent 需要执行 shell、写文件等受控操作时，会在主对话区显示具体操作；还可以选择“后续都允许”，让当前 Copilot Session 不再反复询问。
              </Text>
            )}
          </Card>
          <Paragraph type='secondary'>技能会由 Copilot 根据当前任务自动发现，不需要你逐项选择。这里只写这次调查额外需要记住的背景、关注点或输出要求。</Paragraph>
          <Card title='本次调查说明' className='settings-card'>
            <Text type='secondary'>这不是完整的系统提示，而是一段只对本次调查生效的补充说明。平台规则、证据要求和安全规则由系统维护。</Text>
            <Input.TextArea
              autoSize={{minRows:8,maxRows:18}}
              value={draft.agent.systemPrompt.content}
              onChange={e=>update(next=>{next.agent.systemPrompt.content=e.target.value;})}
              placeholder={'例如：\n本次调查重点关注数据来源、数据血缘和关键业务定义。优先使用现有代码、数据库结构和内部资料；证据不足时明确说明，不要猜测。'}
            />
          </Card>
          <Card size='small' className='settings-card'>
            <Text strong>技能怎么工作</Text>
            <Paragraph type='secondary' style={{marginBottom:0}}>本机的技能目录会一直提供给 Copilot。它会根据你的问题和每个 SKILL.md 的描述，在真正相关时加载对应技能；选择工作方式后，只保留对应 Workflow Skill，避免不同路线混在一起。</Paragraph>
          </Card>
        </div>}
        {tab==='mcp'&&<div className='settings-page'>
          <Flex justify='space-between' align='center'><div><Title level={4}>MCP</Title><Paragraph type='secondary'>Copilot 在本机运行时已经自带一些常用 MCP。这里主要用于接入你自己需要的外部服务。</Paragraph></div><Button icon={<PlusOutlined/>} onClick={addMcp}>添加服务器</Button></Flex>
          <Card title='Copilot 自带的 MCP' className='settings-card'>
            <div className='mcp-builtins'>
              <div><Text strong>GitHub</Text><Text type='secondary'>仓库、代码搜索、Issue、PR、提交记录和 GitHub Actions。</Text></div>
              <div><Text strong>Playwright</Text><Text type='secondary'>浏览器访问、点击、输入和截图。</Text></div>
              <div><Text strong>Fetch</Text><Text type='secondary'>通过 HTTP 获取网页或接口内容。</Text></div>
              <div><Text strong>Time</Text><Text type='secondary'>当前时间和时区转换。</Text></div>
            </div>
            <Text type='secondary'>这些服务不需要在这里添加。实际可用项以本机 Copilot CLI 的 <code>copilot mcp list</code> 为准。</Text>
          </Card>
          <Card size='small' className='settings-card'>
            <Text strong>适合这个应用的外部 MCP</Text>
            <Paragraph type='secondary' style={{marginBottom:0}}>可以按需接入 Atlassian Rovo（Jira / Confluence）、Snowflake、dbt 或 PostgreSQL 等服务。认证和数据权限仍由对应服务负责。</Paragraph>
          </Card>
          <Alert type='warning' showIcon title='不要在这里保存密钥' description='访问令牌、密码和其它凭证应由运行环境或 MCP 服务自己的安全配置管理。'/>
          {draft.agent.mcpServers.map((server,index)=><Card key={`${server.name}-${index}`} className='settings-card mcp-card'><Flex justify='space-between'><Text strong>{server.name}</Text><Button danger type='text' icon={<DeleteOutlined/>} onClick={()=>removeMcp(index)}>删除</Button></Flex>
            <div className='mcp-grid'><label>名称<Input value={server.name} onChange={e=>mutateMcp(index,{name:e.target.value})}/></label><label>连接方式<Select value={server.type} style={{width:'100%'}} options={[{value:'http',label:'HTTP'},{value:'local',label:'本地进程'}]} onChange={value=>mutateMcp(index,{type:value})}/></label></div>
            {server.type==='http'?<label>URL<Input value={server.url} onChange={e=>mutateMcp(index,{url:e.target.value})} placeholder='https://...'/></label>:<><label>启动命令<Input value={server.command} onChange={e=>mutateMcp(index,{command:e.target.value})} placeholder='node / python / ...'/></label><label>启动参数<Select mode='tags' style={{width:'100%'}} value={server.args??[]} onChange={value=>mutateMcp(index,{args:value})}/></label></>}
            <label>允许的工具<Select mode='tags' style={{width:'100%'}} value={server.tools??[]} onChange={value=>mutateMcp(index,{tools:value})} placeholder='留空表示全部工具'/></label>
            <label>请求头（JSON）<Input.TextArea autoSize={{minRows:3,maxRows:8}} value={JSON.stringify(server.headers??{},null,2)} onChange={e=>{try{const parsed=JSON.parse(e.target.value) as unknown;if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)) mutateMcp(index,{headers:parsed as Record<string,string>});}catch{/* invalid JSON is corrected before save */}}}/></label>
          </Card>)}
          {!draft.agent.mcpServers.length?<Empty description='还没有添加额外的 MCP Server。Copilot 自带服务已经可以直接使用。'/>:null}
        </div>}
        {tab==='workflow'&&<div className='settings-page'>
          <Title level={4}>工作方式</Title><Paragraph type='secondary'>工作方式是导航骨架，不是普通筛选项。真正改变它必须是一次明确、可追溯的动作。</Paragraph>
          <Card className='workflow-danger-zone' title='危险区域'><Alert type='warning' showIcon title='不要为了试试看而切换' description='只有真实目标或工作方法发生明确变化时才调整。'/>
            <div className='workflow-danger-grid'><div><div className='field-label'>当前</div><Tag>{workflowOptions.find(x=>x.value===props.workflow)?.label??'自主调查'}</Tag></div><div><div className='field-label'>调整为</div><Select value={workflowTarget} style={{width:'100%'}} options={workflowOptions.filter(x=>x.value!==props.workflow)} placeholder='选择新的工作方式' onChange={value=>{setWorkflowTarget(value);setConfirmText('')}}/></div></div>
            <Divider/><div className='field-label'>确认这次调整</div><Input value={confirmText} onChange={e=>setConfirmText(e.target.value)} placeholder='输入：我确认调整工作方式'/><Flex justify='space-between' align='center'><Text type='secondary'>不会删除调查资料，但会清除旧的动态路线。</Text><Button danger type='primary' disabled={workflowTarget===undefined||confirmText!=='我确认调整工作方式'} loading={saving} onClick={async()=>{if(workflowTarget===undefined)return;await props.onWorkflowChange(workflowTarget);setWorkflowTarget(undefined);setConfirmText('')}}>确认调整工作方式</Button></Flex>
          </Card>
        </div>}
        {tab==='history'&&<div className='settings-page'><Title level={4}>版本历史</Title><Paragraph type='secondary'>每次配置修改都会生成一个版本。当前只展示最近记录。</Paragraph>{draft.history.slice().reverse().map(item=><Card key={item.version} size='small' className='version-card'><Flex justify='space-between'><div><Text strong>配置 v{item.version}</Text><div><Text type='secondary'>{item.reason}</Text></div></div><Text type='secondary'>{formatTime(item.updatedAt)}</Text></Flex></Card>)}{!draft.history.length?<Empty description='暂无配置历史。'/>:null}</div>}
      </main>
    </div>
  </div>;
}