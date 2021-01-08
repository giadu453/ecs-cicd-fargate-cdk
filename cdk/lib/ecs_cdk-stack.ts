import cdk = require('@aws-cdk/core');
import ec2 = require("@aws-cdk/aws-ec2");
import ecr = require('@aws-cdk/aws-ecr');
import ecs = require("@aws-cdk/aws-ecs");
import iam = require("@aws-cdk/aws-iam");
import codebuild = require('@aws-cdk/aws-codebuild');
import codecommit = require('@aws-cdk/aws-codecommit');
import targets = require('@aws-cdk/aws-events-targets');
import codedeploy = require('@aws-cdk/aws-codedeploy');
import codepipeline = require('@aws-cdk/aws-codepipeline');
import codepipeline_actions = require('@aws-cdk/aws-codepipeline-actions');
import ecs_patterns = require("@aws-cdk/aws-ecs-patterns");
import elb = require("@aws-cdk/aws-elasticloadbalancingv2");
import ats = require("@aws-cdk/aws-applicationautoscaling");

export class EcsCdkStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    /**
     * Create a new VPC with single NAT Gateway
     */
    const vpc = new ec2.Vpc(this, 'VPC-Demo', {
      cidr: '10.0.0.0/18',
      natGateways: 1,
      maxAzs: 2
    });

    const clusterAdmin = new iam.Role(this, 'RoleClusterDemo', {
      assumedBy: new iam.AccountRootPrincipal()
    });
    

    const cluster = new ecs.Cluster(this, "ClusterDemo", {
      vpc: vpc,
      containerInsights: true
    });
    
    // Create Group Security
    const applicationLoadBalancerSecurityGroup = new ec2.SecurityGroup(this, 'ApplicationLoadBalancerSecurityGroup', {vpc});
    const ecsFargateServiceSecurityGroup = new ec2.SecurityGroup(this, 'EcsFargateServiceSecurityGroup', {vpc});
    
    // Set open port group security
    applicationLoadBalancerSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80));
    ecsFargateServiceSecurityGroup.addIngressRule(applicationLoadBalancerSecurityGroup, ec2.Port.tcp(8080));
    

    // ***ECS Contructs***

    // ECR - repo
    const ecrRepo = new ecr.Repository(this, 'ECRRepository');


const applicationLoadBalancer = new elb.ApplicationLoadBalancer(this, 'ApplicationLoadBalancer', {
  vpc,
  deletionProtection: false,
  http2Enabled: true,
  internetFacing: true,
  securityGroup: applicationLoadBalancerSecurityGroup,
  vpcSubnets: {subnetType: ec2.SubnetType.PUBLIC}
});
const httpsListener = applicationLoadBalancer.addListener('HttpListener', {
  port: 80,
  protocol: elb.ApplicationProtocol.HTTP,
  defaultAction: elb.ListenerAction.redirect({protocol: 'HTTP', port: '80'})
});

const executionRolePolicy =  new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: ['*'],
      actions: [
                "ecr:GetAuthorizationToken",
                "ecr:BatchCheckLayerAvailability",
                "ecr:GetDownloadUrlForLayer",
                "ecr:BatchGetImage",
                "ecs:DescribeCluster",
                "logs:CreateLogStream",
                "logs:PutLogEvents"
            ]
    });

const taskRole = new iam.Role(this, `ecs-taskRole-${this.stackName}`, {
      roleName: `ecs-taskRole-${this.stackName}`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
    });

const webFargateTaskDefinition = new ecs.FargateTaskDefinition(this, 'WebFargateTaskDefinition', {
  memoryLimitMiB: 512,
  cpu: 256,
  taskRole: taskRole
});

webFargateTaskDefinition.addToExecutionRolePolicy(executionRolePolicy);

const webContainer = webFargateTaskDefinition.addContainer('WEB', {
  image:ecs.ContainerImage.fromEcrRepository(ecrRepo,"latest"),
  // image: ecs.ContainerImage.fromRegistry("amazon/amazon-ecs-sample"),
  logging: ecs.LogDriver.awsLogs({
            streamPrefix: `${this.stackName}WebContainerLog`,
          })
});

webContainer.addPortMappings({
  hostPort: 8080,
  containerPort: 8080,
  protocol: ecs.Protocol.TCP
});


const webFargateServiceTargetGroup = new elb.ApplicationTargetGroup(this,'WebFargateServiceTargetGroup',{
  port: 80,
  healthCheck:{
    enabled: true,
    path: "/",
    port: '8080',
    protocol:elb.Protocol.HTTP,
    unhealthyThresholdCount:5,
    timeout:cdk.Duration.seconds(45),
    interval:cdk.Duration.seconds(60),
    healthyHttpCodes:'200,301,302'
  },
  stickinessCookieDuration:cdk.Duration.seconds(604800),
  targetType: elb.TargetType.IP,
  vpc: vpc
  
});
httpsListener.addTargetGroups('Web', {targetGroups: [webFargateServiceTargetGroup]});

const webFargateService = new ecs.FargateService(this, 'WebFargateService', {
  cluster: cluster,
  desiredCount: 3,
  assignPublicIp: false,
  maxHealthyPercent: 200,
  minHealthyPercent: 50,
  deploymentController: {
    type: ecs.DeploymentControllerType.ECS
  },
  healthCheckGracePeriod: cdk.Duration.seconds(60),
  securityGroups: [ecsFargateServiceSecurityGroup],
  platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
  vpcSubnets: {
    subnetType: ec2.SubnetType.PRIVATE
  },
  taskDefinition: webFargateTaskDefinition
});
webFargateService.node.addDependency(httpsListener);
webFargateService.attachToApplicationTargetGroup(webFargateServiceTargetGroup);

const webServiceScaling = new ats.ScalableTarget(this, 'webFargateServiceScaling', {
  scalableDimension: 'ecs:service:DesiredCount',
  minCapacity: 3,
  maxCapacity: 300,
  serviceNamespace: ats.ServiceNamespace.ECS,
  resourceId: `service/${cluster.clusterName}/${webFargateService.serviceName}`
});

// webServiceScaling.scaleToTrackMetric('RequestCountPerTarget', {
//   predefinedMetric: ats.PredefinedMetric.ALB_REQUEST_COUNT_PER_TARGET,
//   resourceLabel: `${applicationLoadBalancer.loadBalancerFullName}/${webFargateService.serviceName}`,
//   targetValue: 4096,
//   scaleInCooldown: cdk.Duration.minutes(5),
//   scaleOutCooldown: cdk.Duration.minutes(5)
// });

webServiceScaling.scaleToTrackMetric('TargetResponseTime', {
  customMetric: applicationLoadBalancer.metricTargetResponseTime(),
  targetValue: 4,
  scaleInCooldown: cdk.Duration.minutes(3),
  scaleOutCooldown: cdk.Duration.minutes(3)
});




    // ***PIPELINE CONSTRUCTS***



    const repository = new codecommit.Repository(this, 'CodeRepositoryDemo', { repositoryName: 'WebSpringBoot' });

  
  // CODEBUILD - project
    const project = new codebuild.Project(this, 'CodeBuildDemo', {
      projectName: `${this.stackName}`,
      source: codebuild.Source.codeCommit({ repository }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_2,
        privileged: true
      },
      environmentVariables: {
        'ECR_REPO_URI': {
          value: `${ecrRepo.repositoryUri}`
        }
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          pre_build: {
            commands: [
              'COMMIT_HASH=$(echo $CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c 1-7)',
              'IMAGE_TAG=${COMMIT_HASH:=latest}'
            ]
          },
          build: {
            commands: [
              `echo Build springbootdemo`,
              `mvn compile -DskipTests`,
              `mvn package -DskipTests`,
              `echo Building the Docker image...`,
              `docker build -t $ECR_REPO_URI:latest .`,
              `docker tag $ECR_REPO_URI:latest $ECR_REPO_URI:$IMAGE_TAG`,
              '$(aws ecr get-login --no-include-email)',
              'docker push $ECR_REPO_URI:latest',
              'docker push $ECR_REPO_URI:$IMAGE_TAG'
            ]
          },
          post_build: {
            commands: [
              'echo "In Post-Build Stage"',
              "printf '[{\"name\":\"WEB\",\"imageUri\":\"%s\"}]' $ECR_REPO_URI:$IMAGE_TAG > imagedefinitions.json",
              "pwd; ls -al; cat imagedefinitions.json"
            ]
          }
        },
        artifacts: {
          files: [
            'imagedefinitions.json'
          ]
        }
      })
    });

    // ***PIPELINE ACTIONS***

    const sourceOutput = new codepipeline.Artifact();
    const buildOutput = new codepipeline.Artifact();

    const sourceAction = new codepipeline_actions.CodeCommitSourceAction({
      actionName: 'CodeCommit',
      repository,
      output: sourceOutput,
    });

    const buildAction = new codepipeline_actions.CodeBuildAction({
      actionName: 'CodeBuild',
      project: project,
      input: sourceOutput,
      outputs: [buildOutput], // optional
    });

    const manualApprovalAction = new codepipeline_actions.ManualApprovalAction({
      actionName: 'Approve',
    });

    const deployAction = new codepipeline_actions.EcsDeployAction({
      actionName: 'DeployAction',
      service: webFargateService,
      imageFile: new codepipeline.ArtifactPath(buildOutput, `imagedefinitions.json`)
    });



    // PIPELINE STAGES

    new codepipeline.Pipeline(this, 'ECSPipeline', {
      stages: [
        {
          stageName: 'Source',
          actions: [sourceAction],
        },
        {
          stageName: 'Build',
          actions: [buildAction],
        },
        {
          stageName: 'Approve',
          actions: [manualApprovalAction],
        },
        {
          stageName: 'Deploy-to-ECS',
          actions: [deployAction],
        }
      ]
    });


    ecrRepo.grantPullPush(project.role!);
    project.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        "ecs:DescribeCluster",
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer"
        ],
      resources: [`${cluster.clusterArn}`],
    }));


    //OUTPUT

    new cdk.CfnOutput(this, 'LoadBalancerDNS', { value: applicationLoadBalancer.loadBalancerDnsName });
    new cdk.CfnOutput(this, `codecommit-uri`, {
            exportName: 'CodeCommitURL',
            value: repository.repositoryCloneUrlHttp
        });
  }

}
