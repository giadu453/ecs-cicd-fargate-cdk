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
import elbv2 = require('@aws-cdk/aws-elasticloadbalancingv2');
import dockerImg = require('@aws-cdk/aws-ecr-assets');
import path = require('path');

export class EcsCdkStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    /**
     * Create a new VPC with single NAT Gateway
     */
    const vpc = new ec2.Vpc(this, 'ecs-cdk-vpc', {
      cidr: '10.0.0.0/18',
      natGateways: 1,
      maxAzs: 2
    });

    const clusterAdmin = new iam.Role(this, 'AdminRole', {
      assumedBy: new iam.AccountRootPrincipal()
    });

    

    const cluster = new ecs.Cluster(this, "ecs-cluster", {
      vpc: vpc,
    });

    const logging = new ecs.AwsLogDriver({
      streamPrefix: "ecs-logs"
    });

    const taskRole = new iam.Role(this, `ecs-taskRole-${this.stackName}`, {
      roleName: `ecs-taskRole-${this.stackName}`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
    });



     // Load balancer for the service
    const LB = new elbv2.ApplicationLoadBalancer(this, 'LB', {
      vpc:vpc,
      internetFacing: true
    });

    const loadBalancerListener = LB.addListener('PublicListener', { port: 80, open: true });

    loadBalancerListener.addTargetGroups('default', {
      targetGroups: [new elbv2.ApplicationTargetGroup(this, 'default', {
        vpc: vpc,
        protocol: elbv2.ApplicationProtocol.HTTP,
        port: 80
      })]
    });


    // ***ECS Contructs***

    const executionRolePolicy =  new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: ['*'],
      actions: [
                "ecr:GetAuthorizationToken",
                "ecr:BatchCheckLayerAvailability",
                "ecr:GetDownloadUrlForLayer",
                "ecr:BatchGetImage",
                "logs:CreateLogStream",
                "logs:PutLogEvents"
            ]
    });

    const taskDef = new ecs.FargateTaskDefinition(this, "ecs-taskdef", {
      taskRole: taskRole
    });

    taskDef.addToExecutionRolePolicy(executionRolePolicy);

    // ECR - repo
    const ecrRepo = new ecr.Repository(this, 'EcrRepo');
    const imageAsset = new dockerImg.DockerImageAsset(this, 'imageAsset', {directory: path.join(__dirname, 'images'), repositoryName: ecrRepo.repositoryName});
  
    

    const container = taskDef.addContainer('web-app', {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepo,"lastest"),
      memoryLimitMiB: 256,
      cpu: 256,
      logging
    });

    container.addPortMappings({
      containerPort: 8080,
      protocol: ecs.Protocol.TCP
    });

    const fargateService = new ecs.FargateService(this, "ecs-service", {
      cluster: cluster,
      taskDefinition: taskDef,
      desiredCount: 2,
      // Ensure that the rollout is able to happen in one round
      maxHealthyPercent: 200,
      minHealthyPercent: 100,

      // No need for a public IP, we have NAT gateway in this VPC
      assignPublicIp: false
    });

    // const scaling = fargateService.service.autoScaleTaskCount({ maxCapacity: 3 });
    // scaling.scaleOnCpuUtilization('CpuScaling', {
    //   targetUtilizationPercent: 10,
    //   scaleInCooldown: cdk.Duration.seconds(60),
    //   scaleOutCooldown: cdk.Duration.seconds(60)
    // });


    loadBalancerListener.addTargets('name', {
      port: 80,
      pathPattern: '*',
      priority: 1,

      // Only 10 seconds for new tasks to become healthy.
      // Increase if your application is slower to startup
      healthCheck: {
        healthyThresholdCount: 2,
        interval: cdk.Duration.seconds(5),
        timeout: cdk.Duration.seconds(2)
      },

      // Only drain containers for 10 seconds when stopping them.
      // Increase if your app has long lived connections
      deregistrationDelay: cdk.Duration.seconds(10),

      targets: [fargateService]
    });

    // ***PIPELINE CONSTRUCTS***



    const repository = new codecommit.Repository(this, 'MyRepo', { repositoryName: 'foo' });

  
  // CODEBUILD - project
    const project = new codebuild.Project(this, 'MyProject', {
      projectName: `${this.stackName}`,
      // source: gitHubSource,
      source: codebuild.Source.codeCommit({ repository }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_2,
        privileged: true
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          pre_build: {
            commands: [
              'env',
              'export TAG=${CODEBUILD_RESOLVED_SOURCE_VERSION}'
            ]
          },
          build: {
            commands: [
              `docker build -t $ECR_REPO_URI:$TAG .`,
              '$(aws ecr get-login --no-include-email)',
              'docker push $ECR_REPO_URI:$TAG'
            ]
          },
          post_build: {
            commands: [
              'echo "In Post-Build Stage"',
              'cd ..',
              "printf '[{\"name\":\"web-app\",\"imageUri\":\"%s\"}]' $ECR_REPO_URI:$TAG > imagedefinitions.json",
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
      service: fargateService,
      imageFile: new codepipeline.ArtifactPath(buildOutput, `imagedefinitions.json`)
    });



    // PIPELINE STAGES

    new codepipeline.Pipeline(this, 'MyECSPipeline', {
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


    ecrRepo.grantPullPush(project.role!)
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

    new cdk.CfnOutput(this, 'LoadBalancerDNS', { value: LB.loadBalancerDnsName });
    new cdk.CfnOutput(this, `codecommit-uri`, {
            exportName: 'CodeCommitURL',
            value: repository.repositoryCloneUrlHttp
        });
  }

}
