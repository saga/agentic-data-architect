import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Divider, Empty, Flex, Input, Radio, Select, Space, Tag, Typography } from 'antd';
import { ArrowLeftOutlined, DeleteOutlined, PlusOutlined, SaveOutlined, SettingOutlined, ToolOutlined, GithubOutlined, HistoryOutlined } from '@ant-design/icons';

const { Title, Text, Paragraph } = Typography;

export interface ConfigPageControl {
  version:number; updatedAt:string;
  research:{ githubRepositories:string[]; githubSearchMode:'only_selected'|'selected_and_broad'; keywords:string[]; importantDocuments:Array<{id:string;title:string;reference:string}> };
  agent:{ systemPrompt:{version:number;content:string}; skills:Array<{name:string;version:number;parameters?:Record<string,unknown>}>; mcpServers:Array<{name:string;version:number;enabled:boolean;type:'local'|'http';command?:string;args?:string[];url?:string;tools?:string[];headers?:Record<string,string>}> };
  history:Array<{version:number;updatedAt:string;reason:string}>;
}
export interface ConfigPageSkill { name:string; description:string; }
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
  skills:ConfigPageSkill[];
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

  useEffect(()=>setDraft(clone(props.control)),[props.control]);
  const update=(mutator:(next:ConfigPageControl)=>void)=>setDraft(prev=>{const next=clone(prev);mutator(next);return next;});
  const selectedSkillNames=useMemo(()=>draft.agent.skills.map(item=>item.name),[draft.agent.skills]);

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

  const mutateMcp=(index:number, patch:Partial<ConfigPageControl['agent']['mcpServers'][number]>)=>update(next=>{next.agent.mcpServers[index]={...next.agent.mcpServers[index],...patch};});
  const removeMcp=(index:number)=>update(next=>{next.agent.mcpServers.splice(index,1);});
  const addMcp=()=>update(next=>{next.agent.mcpServers.push({name:`mcp-${next.agent.mcpServers.length+1}`,version:1,enabled:true,type:'http',url:'',tools:[]});});

  return <div className='config-page-shell'>
    <header className='subpage-header'>
      <Flex align='center' gap={10}>
        <Button type='text' icon={<ArrowLeftOutlined/>} onClick={props.onBack}>返回调查</Button>
        <Divider type='vertical'/>
        <SettingOutlined/> <Title level={4} style={{margin:0}}>调查配置</Title>
        <Tag>v{props.control.version}</Tag>
      </Flex>
      <Space>
        <Button icon={<SaveOutlined/>} type='primary' loading={saving} onClick={()=>void save()}>保存配置</Button>
      </Space>
    </header>
    <div className='config-page-body'>
      <aside className='config-page-nav'>
        {([['research','研究范围',<GithubOutlined/>],['skills','技能与指导',<ToolOutlined/>],['mcp','MCP',<ToolOutlined/>],['workflow','工作方式',<SettingOutlined/>],['history','版本历史',<HistoryOutlined/>]] as const).map(([key,label,icon])=><button key={key} className={tab===key?'active':''} onClick={()=>setTab(key as typeof tab)}>{icon}<span>{label}</span></button>)}
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
          <Title level={4}>技能与指导</Title><Paragraph type='secondary'>技能决定 Agent 可以采用哪些工作方法；参数是本次调查传给技能的运行配置。</Paragraph>
          <Card title='已启用技能' className='settings-card'><Select mode='multiple' style={{width:'100%'}} value={selectedSkillNames} options={props.skills.map(skill=>({label:skill.name,value:skill.name,title:skill.description}))} onChange={names=>update(next=>{next.agent.skills=names.map(name=>({name,version:next.agent.skills.find(x=>x.name===name)?.version??1,parameters:next.agent.skills.find(x=>x.name===name)?.parameters??{}}));})}/>
            <div className='selected-skill-list'>{draft.agent.skills.map(skill=>{const option=props.skills.find(x=>x.name===skill.name);return <Card key={skill.name} size='small' className='skill-card' title={<Flex justify='space-between'><Text strong>{skill.name}</Text><Tag>v{skill.version}</Tag></Flex>}><Text type='secondary'>{option?.description}</Text><div className='field-label'>运行参数（JSON）</div><Input.TextArea autoSize={{minRows:3,maxRows:10}} value={JSON.stringify(skill.parameters??{},null,2)} onChange={e=>{try{const parsed=JSON.parse(e.target.value) as unknown;if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)) update(next=>{const target=next.agent.skills.find(x=>x.name===skill.name);if(target) target.parameters=parsed as Record<string,unknown>;});}catch{/* 保存时由用户修正 JSON */}}}/></Card>})}</div>
          </Card>
          <Card title='本次调查指导' className='settings-card'><Text type='secondary'>这里适合补充本次调查特有背景；平台 Evidence、安全约束和系统规则不在这里修改。</Text><Input.TextArea autoSize={{minRows:10,maxRows:20}} value={draft.agent.systemPrompt.content} onChange={e=>update(next=>{next.agent.systemPrompt.content=e.target.value;})}/></Card>
          <Alert showIcon type='info' message='技能目前没有统一的参数声明 Schema' description='页面已经支持为每个技能保存运行参数。后续 Skill 可以声明自己的参数类型和默认值，届时这里可以自动生成表单，而不用手写 JSON。'/>
        </div>}
        {tab==='mcp'&&<div className='settings-page'>
          <Flex justify='space-between' align='center'><div><Title level={4}>MCP</Title><Paragraph type='secondary'>逐个配置 MCP Server、连接方式、启动参数、工具范围和请求头。敏感凭证仍不保存到这里。</Paragraph></div><Button icon={<PlusOutlined/>} onClick={addMcp}>添加服务器</Button></Flex>
          <Alert type='warning' showIcon message='不要在这里保存密钥' description='访问令牌、密码和其它凭证应由运行环境或 MCP 服务自己的安全配置管理。'/>
          {draft.agent.mcpServers.map((server,index)=><Card key={`${server.name}-${index}`} className='settings-card mcp-card'><Flex justify='space-between'><Text strong>{server.name}</Text><Button danger type='text' icon={<DeleteOutlined/>} onClick={()=>removeMcp(index)}>删除</Button></Flex>
            <div className='mcp-grid'><label>名称<Input value={server.name} onChange={e=>mutateMcp(index,{name:e.target.value})}/></label><label>连接方式<Select value={server.type} style={{width:'100%'}} options={[{value:'http',label:'HTTP'},{value:'local',label:'本地进程'}]} onChange={value=>mutateMcp(index,{type:value})}/></label></div>
            {server.type==='http'?<label>URL<Input value={server.url} onChange={e=>mutateMcp(index,{url:e.target.value})} placeholder='https://...'/></label>:<><label>启动命令<Input value={server.command} onChange={e=>mutateMcp(index,{command:e.target.value})} placeholder='node / python / ...'/></label><label>启动参数<Select mode='tags' style={{width:'100%'}} value={server.args??[]} onChange={value=>mutateMcp(index,{args:value})}/></label></>}
            <label>允许的工具<Select mode='tags' style={{width:'100%'}} value={server.tools??[]} onChange={value=>mutateMcp(index,{tools:value})} placeholder='留空表示不额外限制'/></label>
            <label>请求头（JSON）<Input.TextArea autoSize={{minRows:3,maxRows:8}} value={JSON.stringify(server.headers??{},null,2)} onChange={e=>{try{const parsed=JSON.parse(e.target.value) as unknown;if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)) mutateMcp(index,{headers:parsed as Record<string,string>});}catch{/* invalid JSON is corrected before save */}}}/></label>
          </Card>)}
          {!draft.agent.mcpServers.length?<Empty description='还没有配置 MCP Server。'/>:null}
        </div>}
        {tab==='workflow'&&<div className='settings-page'>
          <Title level={4}>工作方式</Title><Paragraph type='secondary'>工作方式是导航骨架，不是普通筛选项。真正改变它必须是一次明确、可追溯的动作。</Paragraph>
          <Card className='workflow-danger-zone' title='危险区域'><Alert type='warning' showIcon message='不要为了试试看而切换' description='只有真实目标或工作方法发生明确变化时才调整。'/>
            <div className='workflow-danger-grid'><div><div className='field-label'>当前</div><Tag>{workflowOptions.find(x=>x.value===props.workflow)?.label??'自主调查'}</Tag></div><div><div className='field-label'>调整为</div><Select value={workflowTarget} style={{width:'100%'}} options={workflowOptions.filter(x=>x.value!==props.workflow)} placeholder='选择新的工作方式' onChange={value=>{setWorkflowTarget(value);setConfirmText('')}}/></div></div>
            <Divider/><div className='field-label'>确认这次调整</div><Input value={confirmText} onChange={e=>setConfirmText(e.target.value)} placeholder='输入：我确认调整工作方式'/><Flex justify='space-between' align='center'><Text type='secondary'>不会删除调查资料，但会清除旧的动态路线。</Text><Button danger type='primary' disabled={workflowTarget===undefined||confirmText!=='我确认调整工作方式'} loading={saving} onClick={async()=>{if(workflowTarget===undefined)return;await props.onWorkflowChange(workflowTarget);setWorkflowTarget(undefined);setConfirmText('')}}>确认调整工作方式</Button></Flex>
          </Card>
        </div>}
        {tab==='history'&&<div className='settings-page'><Title level={4}>版本历史</Title><Paragraph type='secondary'>每次配置修改都会生成一个版本。当前只展示最近记录。</Paragraph>{draft.history.slice().reverse().map(item=><Card key={item.version} size='small' className='version-card'><Flex justify='space-between'><div><Text strong>配置 v{item.version}</Text><div><Text type='secondary'>{item.reason}</Text></div></div><Text type='secondary'>{formatTime(item.updatedAt)}</Text></Flex></Card>)}{!draft.history.length?<Empty description='暂无配置历史。'/>:null}</div>}
      </main>
    </div>
  </div>;
}